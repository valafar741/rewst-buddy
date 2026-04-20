import type { SessionChangeEvent } from '@events';
import { FolderLink, Link, TemplateLink } from '@models';
import { FullTemplateFragment, Session, SessionManager } from '@sessions';
import {
	findAllTemplateReferences,
	getHash,
	log,
	makeUniqueUri,
	normalizeTemplateBodyForCompare,
	writeTextFile,
} from '@utils';
import vscode, { Uri } from 'vscode';
import { LinkManager } from './LinkManager';
import { SyncOnSaveManager } from './SyncOnSaveManager';
import { determineSyncAction } from './syncDecision';

/** Returned by `forceDownloadRemoteTemplate` so bulk operations can report skips vs writes. */
export type ForceDownloadRemoteTemplateOutcome = 'applied' | 'metadata-in-sync' | 'skipped-concurrent';

function uriHasOpenTextTab(uri: vscode.Uri): boolean {
	const key = uri.toString();
	const path = uri.fsPath;
	return vscode.window.tabGroups.all.some(group =>
		group.tabs.some(tab => {
			if (!(tab.input instanceof vscode.TabInputText)) {
				return false;
			}
			const u = tab.input.uri;
			return u.toString() === key || u.fsPath === path;
		}),
	);
}

async function readUtf8FileOrThrow(uri: vscode.Uri): Promise<string> {
	const bytes = await vscode.workspace.fs.readFile(uri);
	return new TextDecoder('utf-8').decode(bytes);
}

export const SyncManager = new (class _ implements vscode.Disposable {
	private syncingUris = new Set<string>();
	/** Nesting depth for Download/Upload all linked templates per org (org row spinner for whole run). */
	private orgLinkedTemplateBulkSyncDepth = new Map<string, number>();
	/** Fires when a bulk Download/Upload all linked templates run starts or ends (Linked Templates tree org spinner). */
	private orgLinkedTemplateBulkSyncUiEmitter = new vscode.EventEmitter<void>();
	readonly onOrgLinkedTemplateBulkSyncUiChanged = this.orgLinkedTemplateBulkSyncUiEmitter.event;
	private disposables: vscode.Disposable[] = [];
	private documentEventDisposables: vscode.Disposable[] = [];
	private interval: NodeJS.Timeout | undefined;
	private isActive = false;

	/** True while a bulk Download/Upload all linked templates command is running for this org id. */
	isOrgLinkedTemplateBulkSyncActive(orgId: string): boolean {
		return (this.orgLinkedTemplateBulkSyncDepth.get(orgId) ?? 0) > 0;
	}

	/** Call when starting bulk download/upload for an org (pairs with {@link endOrgLinkedTemplateBulkSync}). */
	beginOrgLinkedTemplateBulkSync(orgId: string): void {
		const n = (this.orgLinkedTemplateBulkSyncDepth.get(orgId) ?? 0) + 1;
		this.orgLinkedTemplateBulkSyncDepth.set(orgId, n);
		if (n === 1) {
			this.orgLinkedTemplateBulkSyncUiEmitter.fire();
		}
	}

	/** Call in `finally` after bulk download/upload for an org finishes. */
	endOrgLinkedTemplateBulkSync(orgId: string): void {
		const prev = this.orgLinkedTemplateBulkSyncDepth.get(orgId) ?? 0;
		if (prev <= 0) {
			return;
		}
		const n = prev - 1;
		if (n <= 0) {
			this.orgLinkedTemplateBulkSyncDepth.delete(orgId);
			this.orgLinkedTemplateBulkSyncUiEmitter.fire();
		} else {
			this.orgLinkedTemplateBulkSyncDepth.set(orgId, n);
		}
	}

	private markLinkedTemplateSyncStarted(uri: vscode.Uri): void {
		this.syncingUris.add(uri.toString());
	}

	private markLinkedTemplateSyncFinished(uri: vscode.Uri): void {
		this.syncingUris.delete(uri.toString());
	}

	init(): _ {
		// Subscribe to session changes
		this.disposables.push(SessionManager.onSessionChange(e => this.handleSessionChange(e)));

		// Check initial state (sessions may already exist from loadSessions())
		if (SessionManager.getActiveSessions().length > 0) {
			this.activate();
		}

		return this;
	}

	private handleSessionChange(event: SessionChangeEvent): void {
		const hasActiveSessions = event.activeProfiles.length > 0;

		if (hasActiveSessions && !this.isActive) {
			this.activate();
		} else if (!hasActiveSessions && this.isActive) {
			this.deactivate();
		}
	}

	private activate(): void {
		if (this.isActive) return;

		log.debug('SyncManager: activating document listeners and folder fetch interval');
		this.isActive = true;

		// Register document event listeners
		this.documentEventDisposables.push(
			vscode.workspace.onDidSaveTextDocument(async doc => await this.handleSave(doc)),
		);
		this.documentEventDisposables.push(
			vscode.workspace.onDidOpenTextDocument(async doc => await this.checkAutoFetch(doc)),
		);

		// Start the folder fetch interval
		this.interval = setInterval(() => this.fetchAllFolders(), 15 * 60 * 1000);
	}

	private deactivate(): void {
		if (!this.isActive) return;

		log.debug('SyncManager: deactivating document listeners and folder fetch interval');
		this.isActive = false;

		// Dispose document event listeners
		this.documentEventDisposables.forEach(d => d.dispose());
		this.documentEventDisposables = [];

		// Clear the interval
		if (this.interval) {
			clearInterval(this.interval);
			this.interval = undefined;
		}
	}

	dispose(): void {
		this.deactivate();
		this.disposables.forEach(d => d.dispose());
		this.orgLinkedTemplateBulkSyncUiEmitter.dispose();
	}

	private async checkAutoFetch(doc: vscode.TextDocument) {
		log.trace('checkAutoFetch: checking', doc.uri.fsPath);

		// Check if autoFetch is enabled via configuration
		const config = vscode.workspace.getConfiguration('rewst-buddy');
		if (!config.get<boolean>('autoFetchOnOpen', true)) {
			log.trace('checkAutoFetch: disabled by configuration, skipping');
			return;
		}

		if (!LinkManager.isLinked(doc.uri)) {
			log.trace('checkAutoFetch: file not linked, skipping');
			return;
		}

		const rawLink = LinkManager.linkMap.get(doc.uri.toString());
		if (!rawLink || rawLink.type !== 'Template') {
			log.trace('checkAutoFetch: not a template link, skipping');
			return;
		}
		const link = rawLink as TemplateLink;

		const session = SessionManager.getSessionForOrg(link.org.id);

		let remoteTemplate;
		try {
			log.trace('checkAutoFetch: fetching remote template', link.template.id);
			remoteTemplate = await session.getTemplate(link.template.id);
		} catch {
			log.trace('checkAutoFetch: failed to fetch remote, skipping');
			return;
		}

		if (link.bodyHash !== getHash(doc.getText())) {
			log.trace('checkAutoFetch: file has changed since last sync');
			return;
		}

		// if the remote template is in sync then we have nothing to fetch
		if (remoteTemplate.updatedAt === link.template.updatedAt) {
			log.trace('checkAutoFetch: remote in sync, no fetch needed');
			return;
		}

		// in this situation the files stats are the same since we last pushed to root,
		// aka no local edits have happened
		// we also have an update we can take down from rewst
		log.debug('checkAutoFetch: remote is newer, applying update', {
			local: link.template.updatedAt,
			remote: remoteTemplate.updatedAt,
		});
		await this.applyTemplateToDocument(doc, session, remoteTemplate);
	}

	private async handleSave(document: vscode.TextDocument): Promise<void> {
		log.trace('Handling save', document);

		const enabled = SyncOnSaveManager.isUriSynced(document.uri);

		if (!enabled) return;

		try {
			await this.syncTemplate(document);
			log.notifyInfo('SUCCESS: Synced template');
		} catch (e) {
			log.notifyError('Failed to sync template:', e);
		}
	}

	async updateTemplateBody(doc: vscode.TextDocument) {
		log.trace('updateTemplateBody: starting', doc.uri.fsPath);
		const link = LinkManager.getTemplateLink(doc.uri);

		const session = SessionManager.getSessionForOrg(link.org.id);

		try {
			const body = doc.getText() ?? '';
			log.debug('updateTemplateBody: sending to Rewst', {
				templateId: link.template.id,
				bodyLength: body.length,
			});
			const response = await session.sdk?.updateTemplateBody({
				id: link.template.id,
				body: body,
			});
			log.debug('updateTemplateBody: response received', response?.template);

			if (response?.template?.id === undefined) {
				throw new Error('Failed to update template: Invalid response from Rewst API (missing template ID)');
			}

			link.template = response.template;
			link.bodyHash = getHash(body);
			link.referencedTemplateIds = findAllTemplateReferences(body);
			this.addLink(link, doc.uri);

			log.info('Saved updated info to template');
		} catch {
			throw log.error('Failure in response from ticket update, unknown if successful');
		}
	}

	async syncTemplate(doc: vscode.TextDocument) {
		log.trace('syncTemplate: starting', doc.uri.fsPath);
		const uriKey = doc.uri.toString();

		if (this.syncingUris.has(uriKey)) {
			log.debug('syncTemplate: already in progress, skipping');
			return;
		}

		this.markLinkedTemplateSyncStarted(doc.uri);
		try {
			await this.syncTemplateInternal(doc);
			log.trace('syncTemplate: completed successfully');
		} catch (e) {
			throw log.error('syncTemplate: failed', e);
		} finally {
			this.markLinkedTemplateSyncFinished(doc.uri);
		}
	}

	/**
	 * Pull latest remote template: compares Rewst body to **on-disk** file text. If they match, only link metadata is
	 * updated and no editor/tab is touched. If they differ, applies the remote body in the editor **without saving**;
	 * opens a tab (preserve focus) only when the file was not already open in a text editor tab.
	 */
	async forceDownloadRemoteTemplate(uri: vscode.Uri): Promise<ForceDownloadRemoteTemplateOutcome> {
		const uriKey = uri.toString();
		if (this.syncingUris.has(uriKey)) {
			log.debug('forceDownloadRemoteTemplate: already in progress, skipping');
			return 'skipped-concurrent';
		}
		this.markLinkedTemplateSyncStarted(uri);
		try {
			return await this.forceDownloadRemoteTemplateInternal(uri);
		} catch (e) {
			throw log.error('forceDownloadRemoteTemplate: failed', e);
		} finally {
			this.markLinkedTemplateSyncFinished(uri);
		}
	}

	private async forceDownloadRemoteTemplateInternal(uri: vscode.Uri): Promise<ForceDownloadRemoteTemplateOutcome> {
		const link = LinkManager.getTemplateLink(uri);
		const session = SessionManager.getSessionForOrg(link.org.id);
		let remoteTemplate: FullTemplateFragment;
		try {
			remoteTemplate = await session.getTemplate(link.template.id);
		} catch {
			throw log.error('forceDownloadRemoteTemplateInternal: failed to fetch remote template');
		}

		const localDiskBody = await readUtf8FileOrThrow(uri);
		const remoteBody = remoteTemplate.body ?? '';

		const localNorm = normalizeTemplateBodyForCompare(localDiskBody);
		const remoteNorm = normalizeTemplateBodyForCompare(remoteBody);
		if (localNorm === remoteNorm) {
			remoteTemplate.body = '';
			const templateLink: TemplateLink = {
				type: 'Template',
				bodyHash: getHash(localNorm),
				referencedTemplateIds: findAllTemplateReferences(localNorm),
				template: remoteTemplate,
				uriString: uri.toString(),
				org: session.profile.org,
			};
			this.addLink(templateLink, uri);
			return 'metadata-in-sync';
		}

		const hadOpenTab = uriHasOpenTextTab(uri);
		const doc = await vscode.workspace.openTextDocument(uri);
		await this.applyRemoteTemplateBodyToOpenDocumentWithoutSaving(doc, session, remoteTemplate);
		if (!hadOpenTab) {
			await vscode.window.showTextDocument(doc, { preview: false, preserveFocus: true });
		}
		return 'applied';
	}

	/** Replace document text with remote body and refresh the template link; does not write to disk. */
	private async applyRemoteTemplateBodyToOpenDocumentWithoutSaving(
		doc: vscode.TextDocument,
		session: Session,
		remoteTemplate: FullTemplateFragment,
	): Promise<void> {
		log.trace('applyRemoteTemplateBodyToOpenDocumentWithoutSaving', {
			templateId: remoteTemplate.id,
			bodyLength: remoteTemplate.body?.length ?? 0,
		});

		const body = remoteTemplate.body ?? '';
		remoteTemplate.body = '';

		const edit = new vscode.WorkspaceEdit();
		edit.replace(
			doc.uri,
			new vscode.Range(doc.lineAt(0).range.start, doc.lineAt(doc.lineCount - 1).range.end),
			body,
		);
		await vscode.workspace.applyEdit(edit);

		const templateLink: TemplateLink = {
			type: 'Template',
			bodyHash: getHash(body),
			referencedTemplateIds: findAllTemplateReferences(body),
			template: remoteTemplate,
			uriString: doc.uri.toString(),
			org: session.profile.org,
		};

		this.addLink(templateLink, doc.uri);
	}

	/** Push current local file body to Rewst (no merge / conflict prompt). */
	async forceUploadLocalTemplate(doc: vscode.TextDocument): Promise<void> {
		const uriKey = doc.uri.toString();
		if (this.syncingUris.has(uriKey)) {
			log.debug('forceUploadLocalTemplate: already in progress, skipping');
			return;
		}
		this.markLinkedTemplateSyncStarted(doc.uri);
		try {
			await this.forceUploadLocalTemplateInternal(doc);
		} catch (e) {
			throw log.error('forceUploadLocalTemplate: failed', e);
		} finally {
			this.markLinkedTemplateSyncFinished(doc.uri);
		}
	}

	private async forceUploadLocalTemplateInternal(doc: vscode.TextDocument): Promise<void> {
		await this.ensureTemplateDocumentSaved(doc);
		await this.updateTemplateBody(doc);
	}

	private async ensureTemplateDocumentSaved(doc: vscode.TextDocument): Promise<void> {
		if (doc.isUntitled) {
			throw log.error('ensureTemplateDocumentSaved: document is untitled');
		}

		if (doc.isDirty) {
			log.trace('ensureTemplateDocumentSaved: saving dirty document');
			const resultUri = await doc.save();
			if (!resultUri) {
				throw log.error('ensureTemplateDocumentSaved: failed to save document');
			}
		}
	}

	private async syncTemplateInternal(doc: vscode.TextDocument) {
		log.trace('syncTemplateInternal: starting');

		await this.ensureTemplateDocumentSaved(doc);

		const link = LinkManager.getTemplateLink(doc.uri);
		log.debug('syncTemplateInternal: syncing template', {
			templateId: link.template.id,
			templateName: link.template.name,
		});

		const session = SessionManager.getSessionForOrg(link.org.id);

		let remoteTemplate;
		try {
			log.trace('syncTemplateInternal: fetching remote template');
			remoteTemplate = await session.getTemplate(link.template.id);
		} catch {
			throw log.error('syncTemplateInternal: failed to fetch remote template');
		}

		const localBody = doc.getText();
		const currentBodyHash = getHash(localBody);

		log.debug('syncTemplateInternal: comparing states', {
			localUpdatedAt: link.template.updatedAt,
			remoteUpdatedAt: remoteTemplate.updatedAt,
			storedBodyHash: link.bodyHash,
			currentBodyHash,
		});

		const decision = determineSyncAction({
			localUpdatedAt: link.template.updatedAt,
			remoteUpdatedAt: remoteTemplate.updatedAt,
			localBody,
			remoteBody: remoteTemplate.body,
		});

		log.debug('syncTemplateInternal: decision', decision.action);

		switch (decision.action) {
			case 'update-metadata': {
				// Bodies match - just update link metadata with latest remote info
				remoteTemplate.body = '';
				const templateLink: TemplateLink = {
					type: 'Template',
					bodyHash: currentBodyHash,
					referencedTemplateIds: findAllTemplateReferences(localBody),
					template: remoteTemplate,
					uriString: doc.uri.toString(),
					org: session.profile.org,
				};
				this.addLink(templateLink, doc.uri);
				break;
			}

			case 'download-remote':
				log.debug('syncTemplateInternal: downloading remote (local empty)');
				await this.applyTemplateToDocument(doc, session, remoteTemplate);
				break;

			case 'upload-local':
				log.debug('syncTemplateInternal: uploading local changes (in sync)');
				await this.updateTemplateBody(doc);
				break;

			case 'conflict':
				log.debug('syncTemplateInternal: conflict detected');
				await this.handleConflict(doc, session, remoteTemplate);
				break;
		}
	}

	private async handleConflict(doc: vscode.TextDocument, session: Session, remoteTemplate: FullTemplateFragment) {
		log.debug('handleConflict: conflict detected, prompting user');
		log.info('Rewst and last update of local template are out of sync, need to remediate before push');

		const choice = await vscode.window.showInformationMessage(
			'Template and Rewst are out of sync! Do you wish to force upload to rewst, or download the latest version of the template?',
			{ modal: true },
			'Force Override',
			'Download Latest',
		);

		log.debug('handleConflict: user chose', choice);

		switch (choice) {
			case 'Force Override':
				log.trace('handleConflict: force overriding remote');
				await this.updateTemplateBody(doc);
				break;

			case 'Download Latest':
				log.trace('handleConflict: downloading remote');
				await this.applyTemplateToDocument(doc, session, remoteTemplate);
				break;

			case undefined:
				throw log.error('handleConflict: operation aborted by user');
		}
	}

	async applyTemplateToDocument(doc: vscode.TextDocument, session: Session, remoteTemplate: FullTemplateFragment) {
		const uriKey = doc.uri.toString();
		const weOwnSyncActivity = !this.syncingUris.has(uriKey);
		if (weOwnSyncActivity) {
			this.markLinkedTemplateSyncStarted(doc.uri);
		}
		try {
			log.trace('applyTemplateToDocument: applying remote template', {
				templateId: remoteTemplate.id,
				bodyLength: remoteTemplate.body?.length ?? 0,
			});

			const body = remoteTemplate.body ?? '';
			remoteTemplate.body = '';

			const edit = new vscode.WorkspaceEdit();
			edit.replace(
				doc.uri,
				new vscode.Range(doc.lineAt(0).range.start, doc.lineAt(doc.lineCount - 1).range.end),
				body,
			);
			await vscode.workspace.applyEdit(edit);

			const templateLink: TemplateLink = {
				type: 'Template',
				bodyHash: getHash(body),
				referencedTemplateIds: findAllTemplateReferences(body),
				template: remoteTemplate,
				uriString: doc.uri.toString(),
				org: session.profile.org,
			};

			this.addLink(templateLink, doc.uri);

			if ((await vscode.workspace.save(doc.uri)) === undefined) {
				throw log.error('applyTemplateToDocument: failed to save');
			}

			log.trace('applyTemplateToDocument: completed');
		} finally {
			if (weOwnSyncActivity) {
				this.markLinkedTemplateSyncFinished(doc.uri);
			}
		}
	}

	private addLink(link: Link, uri: Uri) {
		log.trace('SyncManager.addLink: updating link with', uri.fsPath);
		LinkManager.addLink(link);
		log.trace('addLink: saved');
	}

	async fetchAllFolders() {
		if (!this.isActive) return;

		log.debug('Fetching all folders');
		const links = LinkManager.getFolderLinks();
		for (const link of links) {
			if (!this.isActive) break; // Stop if deactivated mid-fetch
			await this.fetchFolder(link);
		}
	}

	async fetchFolder(folderLink: FolderLink) {
		log.trace('fetchFolder: starting', { org: folderLink.org.name, uri: folderLink.uriString });

		const { org, uriString } = folderLink;

		const ids = LinkManager.getOrgTemplateLinks(org).map(l => l.template.id);
		log.debug('fetchFolder: existing template count', ids.length);

		const session = SessionManager.getSessionForOrg(org.id);

		log.trace('fetchFolder: listing templates from Rewst');
		const response = await session.sdk?.listTemplates({ orgId: org.id });
		if (!response?.templates) throw log.notifyError("fetchFolder: couldn't load templates");

		const templates = response.templates;
		log.debug('fetchFolder: remote template count', templates.length);

		const missingTemplates = templates.filter(t => !ids.includes(t.id));
		log.debug('fetchFolder: missing templates to fetch', missingTemplates.length);

		if (missingTemplates.length === 0) {
			log.trace('fetchFolder: no missing templates');
			return;
		}

		// BEGIN BATCH MODE - defer saves until all templates processed
		LinkManager.beginBatch();
		let successCount = 0;
		try {
			const folderUri = vscode.Uri.parse(uriString);
			const CHUNK_SIZE = 20;

			// Phase 1: Generate unique URIs (must be sequential for conflict detection)
			const templateUris = new Map<string, Uri>();
			const reservedUris = new Set<string>(); // Track allocated URIs for duplicates
			for (const template of missingTemplates) {
				const uri = await makeUniqueUri(folderUri, template.name, reservedUris);
				templateUris.set(template.id, uri);
				reservedUris.add(uri.toString());
			}

			// Phase 2: Fetch full templates with body (in chunks)
			const fullTemplates = new Map<string, FullTemplateFragment>();
			for (let i = 0; i < missingTemplates.length; i += CHUNK_SIZE) {
				const chunk = missingTemplates.slice(i, i + CHUNK_SIZE);
				const results = await Promise.all(
					chunk.map(async t => {
						try {
							const full = await session.getTemplate(t.id);
							return { id: t.id, template: full };
						} catch (err) {
							log.warn(`fetchFolder: failed to fetch template "${t.name}": ${err}`);
							return null;
						}
					}),
				);
				results.forEach(r => {
					if (r) fullTemplates.set(r.id, r.template);
				});
			}

			// Phase 3: Write files in chunks
			const idsToProcess = Array.from(fullTemplates.keys());

			for (let i = 0; i < idsToProcess.length; i += CHUNK_SIZE) {
				const chunkIds = idsToProcess.slice(i, i + CHUNK_SIZE);
				const results = await Promise.all(
					chunkIds.map(async id => {
						const template = fullTemplates.get(id)!;
						const uri = templateUris.get(id)!;
						try {
							const body = template.body;
							await writeTextFile(uri, body);
							log.trace('fetchFolder: file written', uri.fsPath);

							template.body = '';
							const templateLink: TemplateLink = {
								type: 'Template',
								template: template,
								bodyHash: getHash(body),
								referencedTemplateIds: findAllTemplateReferences(body),
								uriString: uri.toString(),
								org: org,
							};

							LinkManager.addLink(templateLink); // Batched - no immediate save
							return true;
						} catch (err) {
							log.warn(`fetchFolder: failed to create file for "${template.name}": ${err}`);
							return false;
						}
					}),
				);
				successCount += results.filter(Boolean).length;
			}
		} finally {
			// Single save + event emission
			await LinkManager.endBatch();
		}

		log.trace('fetchFolder: completed');
		const message =
			successCount === missingTemplates.length
				? `SUCCESS: Fetched ${successCount} templates into the folder`
				: `Fetched ${successCount}/${missingTemplates.length} templates into the folder`;
		log.notifyInfo(message);
	}
})();
