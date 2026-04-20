import { isDescendant, log } from '@utils';
import path from 'path';
import vscode from 'vscode';
import { LinkManager } from './LinkManager';
import type { FolderLink, Link, TemplateLink } from './types';

export const WORKSPACE_LINKS_FILE_NAME = '.rewst-buddy';

const FORMAT_VERSION = 1;
const OWN_WRITE_GUARD_MS = 1500;
const DEBOUNCE_APPLY_MS = 400;
const DEBOUNCE_WRITE_MS = 300;

/** Link shape stored in `.rewst-buddy` (paths relative to the workspace folder root). */
export type SerializedWorkspaceLink =
	| ({ type: 'Template' } & Omit<TemplateLink, 'uriString'> & { path: string })
	| ({ type: 'Folder' } & Omit<FolderLink, 'uriString'> & { path: string });

interface WorkspaceLinksFileJson {
	version: number;
	links: SerializedWorkspaceLink[];
}

function workspaceLinksFileEnabled(): boolean {
	return vscode.workspace.getConfiguration('rewst-buddy').get<boolean>('workspaceLinksFile', true);
}

function isFileUriUnderWorkspaceFolder(folder: vscode.WorkspaceFolder, target: vscode.Uri): boolean {
	if (target.scheme !== 'file' || folder.uri.scheme !== 'file') {
		return false;
	}
	return isDescendant(folder.uri, target) || target.fsPath === folder.uri.fsPath;
}

function relativePathForFile(folder: vscode.WorkspaceFolder, fileUri: vscode.Uri): string | undefined {
	if (!isFileUriUnderWorkspaceFolder(folder, fileUri)) {
		return undefined;
	}
	const rel = path.relative(folder.uri.fsPath, fileUri.fsPath);
	if (rel.startsWith('..') || path.isAbsolute(rel)) {
		return undefined;
	}
	return rel.split(path.sep).join('/');
}

function safePathSegments(rel: string): string[] {
	const parts = rel.split('/').filter(p => p.length > 0 && p !== '.');
	if (parts.some(p => p === '..')) {
		throw new Error('Invalid path in .rewst-buddy (path traversal)');
	}
	return parts;
}

function absoluteUriForRelativePath(folder: vscode.WorkspaceFolder, rel: string): vscode.Uri {
	const segments = safePathSegments(rel);
	let u = folder.uri;
	for (const s of segments) {
		u = vscode.Uri.joinPath(u, s);
	}
	return u;
}

function toSerializedLink(link: Link, folder: vscode.WorkspaceFolder): SerializedWorkspaceLink | undefined {
	const uri = vscode.Uri.parse(link.uriString);
	const rel = relativePathForFile(folder, uri);
	if (rel === undefined) {
		return undefined;
	}

	if (link.type === 'Template') {
		const tl = link as TemplateLink;
		const template = { ...tl.template, body: undefined as undefined };
		const { uriString: _, ...rest } = tl;
		return { ...rest, path: rel, template };
	}

	const fl = link as FolderLink;
	const { uriString: _, ...rest } = fl;
	return { ...rest, path: rel };
}

function fromSerializedLink(folder: vscode.WorkspaceFolder, s: SerializedWorkspaceLink): Link {
	const uri = absoluteUriForRelativePath(folder, s.path);
	const uriString = uri.toString();
	if (s.type === 'Template') {
		const row = s as TemplateLink & { path: string };
		const { path: _p, ...rest } = row;
		return {
			...rest,
			uriString,
			template: { ...rest.template, body: undefined },
		} as TemplateLink;
	}
	const row = s as FolderLink & { path: string };
	const { path: _p, ...rest } = row;
	return { ...rest, uriString } as FolderLink;
}

async function readWorkspaceFile(folder: vscode.WorkspaceFolder): Promise<WorkspaceLinksFileJson | undefined> {
	const fileUri = vscode.Uri.joinPath(folder.uri, WORKSPACE_LINKS_FILE_NAME);
	try {
		const raw = await vscode.workspace.fs.readFile(fileUri);
		const parsed = JSON.parse(new TextDecoder().decode(raw)) as WorkspaceLinksFileJson;
		if (parsed.version !== FORMAT_VERSION || !Array.isArray(parsed.links)) {
			log.warn('WorkspaceLinksFile: invalid .rewst-buddy structure', folder.name);
			return undefined;
		}
		return parsed;
	} catch (e) {
		if (e instanceof vscode.FileSystemError && e.code === 'FileNotFound') {
			return undefined;
		}
		log.warn('WorkspaceLinksFile: failed to read .rewst-buddy', folder.name, e);
		return undefined;
	}
}

async function applyWorkspaceFileToLinkManager(folder: vscode.WorkspaceFolder): Promise<void> {
	const data = await readWorkspaceFile(folder);
	if (data === undefined) {
		return;
	}

	const toRemove: string[] = [];
	for (const uriString of LinkManager.getAllUriStrings()) {
		const u = vscode.Uri.parse(uriString);
		if (isFileUriUnderWorkspaceFolder(folder, u)) {
			toRemove.push(uriString);
		}
	}

	LinkManager.beginBatch();
	try {
		for (const uriString of toRemove) {
			LinkManager.removeLink(uriString);
		}

		for (const s of data.links) {
			try {
				const link = fromSerializedLink(folder, s);
				LinkManager.addLink(link);
			} catch (err) {
				log.warn('WorkspaceLinksFile: skipped invalid link entry', err);
			}
		}
	} finally {
		await LinkManager.endBatch();
	}
}

async function writeWorkspaceFileForFolder(folder: vscode.WorkspaceFolder): Promise<void> {
	const links: SerializedWorkspaceLink[] = [];
	for (const link of LinkManager.linkMap.values()) {
		const s = toSerializedLink(link, folder);
		if (s !== undefined) {
			links.push(s);
		}
	}

	const payload: WorkspaceLinksFileJson = {
		version: FORMAT_VERSION,
		links,
	};
	const fileUri = vscode.Uri.joinPath(folder.uri, WORKSPACE_LINKS_FILE_NAME);
	const content = `${JSON.stringify(payload, null, 2)}\n`;
	await vscode.workspace.fs.writeFile(fileUri, new TextEncoder().encode(content));
}

export const WorkspaceLinksFile = new (class _WorkspaceLinksFile implements vscode.Disposable {
	private disposables: vscode.Disposable[] = [];
	private folderWatchers = new Map<string, vscode.FileSystemWatcher>();
	private lastOwnWriteAt = 0;
	private applyTimer: NodeJS.Timeout | undefined;
	private writeTimer: NodeJS.Timeout | undefined;
	private pendingApplyFolders = new Set<vscode.WorkspaceFolder>();
	private linksSavedSub: vscode.Disposable | undefined;

	init(): vscode.Disposable {
		void this.bootstrapFromDisk().then(() => this.ensureMissingWorkspaceFilesWritten());

		this.linksSavedSub = LinkManager.onLinksSaved(() => {
			if (!workspaceLinksFileEnabled()) {
				return;
			}
			this.scheduleWriteAll();
		});

		this.refreshFolderWatchers();
		this.disposables.push(
			vscode.workspace.onDidChangeWorkspaceFolders(() => {
				this.refreshFolderWatchers();
				void this.bootstrapFromDisk().then(() => this.ensureMissingWorkspaceFilesWritten());
			}),
		);

		return {
			dispose: () => this.dispose(),
		};
	}

	dispose(): void {
		this.linksSavedSub?.dispose();
		this.linksSavedSub = undefined;
		if (this.applyTimer) {
			clearTimeout(this.applyTimer);
			this.applyTimer = undefined;
		}
		if (this.writeTimer) {
			clearTimeout(this.writeTimer);
			this.writeTimer = undefined;
		}
		for (const w of this.folderWatchers.values()) {
			w.dispose();
		}
		this.folderWatchers.clear();
		this.disposables.forEach(d => d.dispose());
		this.disposables = [];
	}

	private async bootstrapFromDisk(): Promise<void> {
		if (!workspaceLinksFileEnabled()) {
			return;
		}
		LinkManager.loadIfNotAlready();
		for (const folder of vscode.workspace.workspaceFolders ?? []) {
			await applyWorkspaceFileToLinkManager(folder);
		}
	}

	/** Create `.rewst-buddy` when a folder has links (e.g. from globalState) but no workspace file yet. */
	private async ensureMissingWorkspaceFilesWritten(): Promise<void> {
		if (!workspaceLinksFileEnabled()) {
			return;
		}
		LinkManager.loadIfNotAlready();
		for (const folder of vscode.workspace.workspaceFolders ?? []) {
			const fileUri = vscode.Uri.joinPath(folder.uri, WORKSPACE_LINKS_FILE_NAME);
			try {
				await vscode.workspace.fs.stat(fileUri);
				continue;
			} catch {
				// file missing
			}
			const hasLinks = [...LinkManager.linkMap.values()].some(link =>
				isFileUriUnderWorkspaceFolder(folder, vscode.Uri.parse(link.uriString)),
			);
			if (!hasLinks) {
				continue;
			}
			this.lastOwnWriteAt = Date.now();
			try {
				await writeWorkspaceFileForFolder(folder);
				log.info('WorkspaceLinksFile: created .rewst-buddy for folder', folder.name);
			} catch (e) {
				log.error('WorkspaceLinksFile: failed to create .rewst-buddy', folder.name, e);
			}
		}
	}

	private refreshFolderWatchers(): void {
		for (const w of this.folderWatchers.values()) {
			w.dispose();
		}
		this.folderWatchers.clear();

		for (const folder of vscode.workspace.workspaceFolders ?? []) {
			const key = folder.uri.toString();
			const watcher = vscode.workspace.createFileSystemWatcher(
				new vscode.RelativePattern(folder, WORKSPACE_LINKS_FILE_NAME),
			);
			const onEvent = (e: vscode.Uri) => {
				if (!workspaceLinksFileEnabled()) {
					return;
				}
				if (Date.now() - this.lastOwnWriteAt < OWN_WRITE_GUARD_MS) {
					return;
				}
				const fileUri = vscode.Uri.joinPath(folder.uri, WORKSPACE_LINKS_FILE_NAME);
				if (e.toString() !== fileUri.toString()) {
					return;
				}
				this.pendingApplyFolders.add(folder);
				this.scheduleApplyDebounced();
			};
			watcher.onDidChange(onEvent);
			watcher.onDidCreate(onEvent);
			this.folderWatchers.set(key, watcher);
		}
	}

	private scheduleApplyDebounced(): void {
		if (this.applyTimer) {
			clearTimeout(this.applyTimer);
		}
		this.applyTimer = setTimeout(() => {
			this.applyTimer = undefined;
			void this.flushPendingApply();
		}, DEBOUNCE_APPLY_MS);
	}

	private async flushPendingApply(): Promise<void> {
		const folders = [...this.pendingApplyFolders];
		this.pendingApplyFolders.clear();
		if (!workspaceLinksFileEnabled()) {
			return;
		}
		for (const folder of folders) {
			await applyWorkspaceFileToLinkManager(folder);
		}
	}

	private scheduleWriteAll(): void {
		if (this.writeTimer) {
			clearTimeout(this.writeTimer);
		}
		this.writeTimer = setTimeout(() => {
			this.writeTimer = undefined;
			void this.writeAllWorkspaceFiles();
		}, DEBOUNCE_WRITE_MS);
	}

	private async writeAllWorkspaceFiles(): Promise<void> {
		if (!workspaceLinksFileEnabled()) {
			return;
		}
		const folders = vscode.workspace.workspaceFolders ?? [];
		if (folders.length === 0) {
			return;
		}

		this.lastOwnWriteAt = Date.now();
		for (const folder of folders) {
			try {
				await writeWorkspaceFileForFolder(folder);
			} catch (e) {
				log.error('WorkspaceLinksFile: failed to write .rewst-buddy', folder.name, e);
			}
		}
	}
})();
