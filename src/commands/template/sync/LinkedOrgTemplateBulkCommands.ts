import { LinkManager, SyncManager } from '@models';
import { parseOrgIdFromLinkedTemplatesTreeContext } from '@ui';
import { log } from '@utils';
import vscode from 'vscode';
import GenericCommand from '../../GenericCommand';

/** VS Code passes the TreeDataProvider element (e.g. OrgGroupNode), not the TreeItem — org rows have no contextValue on the element. */
function tryParseLinkedTemplatesOrgIdFromArg(x: unknown): string | undefined {
	if (!x || typeof x !== 'object' || Array.isArray(x)) {
		return undefined;
	}
	const o = x as { kind?: unknown; orgId?: unknown; contextValue?: unknown };
	if (typeof o.contextValue === 'string' && o.contextValue.length > 0) {
		const fromCv = parseOrgIdFromLinkedTemplatesTreeContext(o.contextValue);
		if (fromCv) {
			return fromCv;
		}
	}
	if (o.kind === 'org' && typeof o.orgId === 'string') {
		return o.orgId;
	}
	return undefined;
}

function findOrgIdFromLinkedTemplatesTreeArgs(args: unknown[]): string | undefined {
	const stack: unknown[] = [...args];
	while (stack.length) {
		const x = stack.pop()!;
		if (Array.isArray(x)) {
			stack.push(...x);
			continue;
		}
		const id = tryParseLinkedTemplatesOrgIdFromArg(x);
		if (id) {
			return id;
		}
	}
	return undefined;
}

function workspaceTemplateLinksForOrg(orgId: string) {
	return LinkManager.getOrgTemplateLinks({ id: orgId, name: '' }).filter(
		link => vscode.workspace.getWorkspaceFolder(vscode.Uri.parse(link.uriString)) !== undefined,
	);
}

function orgIdFromLinkedTemplatesTreeArgs(args: unknown[]): string | undefined {
	return findOrgIdFromLinkedTemplatesTreeArgs(args);
}

async function runBulkForOrg(args: unknown[], operation: 'download' | 'upload'): Promise<void> {
	const orgId = orgIdFromLinkedTemplatesTreeArgs(args);
	if (!orgId) {
		log.notifyError(`Bulk ${operation}: use this command from an organization row in the Linked templates view.`);
		return;
	}

	const links = workspaceTemplateLinksForOrg(orgId);
	if (links.length === 0) {
		log.notifyInfo('No linked templates in this workspace for that organization.');
		return;
	}

	const verb = operation === 'download' ? 'download' : 'upload';
	let ok = 0;
	let failed = 0;
	let skippedConcurrent = 0;

	SyncManager.beginOrgLinkedTemplateBulkSync(orgId);
	try {
		// Defer LinkManager.fire / globalState / .rewst-buddy until all items finish so tree views and activity bar do not refresh per file.
		LinkManager.beginBatch();
		try {
			for (const link of links) {
				const uri = vscode.Uri.parse(link.uriString);
				try {
					if (operation === 'download') {
						const outcome = await SyncManager.forceDownloadRemoteTemplate(uri);
						if (outcome === 'skipped-concurrent') {
							skippedConcurrent++;
						} else {
							ok++;
						}
					} else {
						const doc = await vscode.workspace.openTextDocument(uri);
						await SyncManager.forceUploadLocalTemplate(doc);
						ok++;
					}
				} catch (e) {
					log.notifyError(`Failed to ${verb} ${uri.fsPath}`, e);
					failed++;
				}
			}
		} finally {
			await LinkManager.endBatch();
		}
	} finally {
		SyncManager.endOrgLinkedTemplateBulkSync(orgId);
	}

	const past = operation === 'download' ? 'Downloaded' : 'Uploaded';
	const parts: string[] = [];
	if (ok > 0) {
		parts.push(`${past} ${ok} template(s)`);
	}
	if (operation === 'download' && skippedConcurrent > 0) {
		parts.push(`skipped ${skippedConcurrent} (already in progress)`);
	}
	if (failed > 0) {
		parts.push(`${failed} failed`);
	}
	const summary =
		parts.length > 0 ? parts.join('; ') : `No templates ${verb === 'download' ? 'updated' : 'uploaded'}`;
	if (failed === 0) {
		log.notifyInfo(`SUCCESS: ${summary}`);
	} else {
		log.notifyInfo(summary);
	}
}

export class DownloadLinkedOrgTemplates extends GenericCommand {
	commandName = 'DownloadLinkedOrgTemplates';

	async execute(...args: unknown[]): Promise<void> {
		await runBulkForOrg(args, 'download');
	}
}

export class UploadLinkedOrgTemplates extends GenericCommand {
	commandName = 'UploadLinkedOrgTemplates';

	async execute(...args: unknown[]): Promise<void> {
		await runBulkForOrg(args, 'upload');
	}
}
