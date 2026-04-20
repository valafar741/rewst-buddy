import { LinkManager, SyncManager } from '@models';
import { parseOrgIdFromLinkedTemplatesTreeContext } from '@ui';
import { log } from '@utils';
import vscode from 'vscode';
import GenericCommand from '../../GenericCommand';

function findTreeItemContextValueFromArgs(args: unknown[]): string | undefined {
	const stack: unknown[] = [...args];
	while (stack.length) {
		const x = stack.pop()!;
		if (Array.isArray(x)) {
			stack.push(...x);
			continue;
		}
		if (x && typeof x === 'object' && 'contextValue' in x) {
			const cv = (x as vscode.TreeItem).contextValue;
			if (typeof cv === 'string' && cv.length > 0) {
				return cv;
			}
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
	return parseOrgIdFromLinkedTemplatesTreeContext(findTreeItemContextValueFromArgs(args));
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
	for (const link of links) {
		const uri = vscode.Uri.parse(link.uriString);
		try {
			const doc = await vscode.workspace.openTextDocument(uri);
			if (operation === 'download') {
				await SyncManager.forceDownloadRemoteTemplate(doc);
			} else {
				await SyncManager.forceUploadLocalTemplate(doc);
			}
			ok++;
		} catch (e) {
			log.notifyError(`Failed to ${verb} ${uri.fsPath}`, e);
			failed++;
		}
	}

	const past = operation === 'download' ? 'Downloaded' : 'Uploaded';
	if (failed === 0) {
		log.notifyInfo(`SUCCESS: ${past} ${ok} template(s) for organization`);
	} else {
		log.notifyInfo(`${past} ${ok} template(s); ${failed} failed`);
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
