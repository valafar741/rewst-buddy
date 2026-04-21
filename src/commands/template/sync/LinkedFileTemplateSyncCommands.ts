import { LinkManager, SyncManager } from '@models';
import { getDocumentFromArgs, log } from '@utils';
import vscode from 'vscode';
import GenericCommand from '../../GenericCommand';

async function requireTemplateLinkFromArgs(args: unknown[]): Promise<{ uri: vscode.Uri; doc: vscode.TextDocument }> {
	const doc = await getDocumentFromArgs(args as any[]);
	const uri = doc.uri;
	try {
		LinkManager.getTemplateLink(uri);
	} catch {
		throw log.error('File is not linked to a Rewst template.');
	}
	return { uri, doc };
}

export class DownloadLinkedTemplateFile extends GenericCommand {
	commandName = 'DownloadLinkedTemplateFile';

	async execute(...args: unknown[]): Promise<void> {
		try {
			const { uri } = await requireTemplateLinkFromArgs(args);
			const outcome = await SyncManager.forceDownloadRemoteTemplate(uri);
			if (outcome === 'skipped-concurrent') {
				log.notifyInfo('A sync is already in progress for this file.');
				return;
			}
			if (outcome === 'metadata-in-sync') {
				log.notifyInfo('Linked file already matches Rewst; link metadata refreshed.');
			} else {
				log.notifyInfo('SUCCESS: Loaded latest template from Rewst (save the file to persist if needed).');
			}
		} catch (e) {
			log.notifyError('Failed to download template from Rewst:', e);
		}
	}
}

export class UploadLinkedTemplateFile extends GenericCommand {
	commandName = 'UploadLinkedTemplateFile';

	async execute(...args: unknown[]): Promise<void> {
		try {
			const { doc } = await requireTemplateLinkFromArgs(args);
			await SyncManager.forceUploadLocalTemplate(doc);
			log.notifyInfo('SUCCESS: Uploaded template body to Rewst');
		} catch (e) {
			log.notifyError('Failed to upload template to Rewst:', e);
		}
	}
}
