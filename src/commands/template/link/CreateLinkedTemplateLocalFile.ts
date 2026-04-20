import { LinkManager, TemplateLink } from '@models';
import { SessionManager } from '@sessions';
import {
	ensureParentDirectories,
	findAllTemplateReferences,
	getHash,
	log,
	parseArgsUri,
	uriExists,
	writeTextFile,
} from '@utils';
import vscode from 'vscode';
import GenericCommand from '../../GenericCommand';

export class CreateLinkedTemplateLocalFile extends GenericCommand {
	commandName = 'CreateLinkedTemplateLocalFile';

	async execute(...args: unknown[]): Promise<void> {
		const uri = parseArgsUri(args);

		if (uri.scheme !== 'file') {
			log.notifyError('Create local file: only workspace files are supported.');
			return;
		}

		if (await uriExists(uri)) {
			log.notifyInfo('File already exists.');
			return;
		}

		let link: TemplateLink;
		try {
			link = LinkManager.getTemplateLink(uri);
		} catch {
			log.notifyError('No template link found for this path.');
			return;
		}

		if (!SessionManager.hasActiveSessions()) {
			log.notifyError('Create local file: start a Rewst session first.');
			return;
		}

		let session;
		try {
			session = SessionManager.getSessionForOrg(link.org.id);
		} catch {
			log.notifyError('Create local file: no session for this template’s organization.');
			return;
		}

		let remote;
		try {
			remote = await session.getTemplate(link.template.id);
		} catch (e) {
			log.notifyError('Failed to fetch template from Rewst.', e);
			return;
		}

		try {
			await ensureParentDirectories(uri);
		} catch (e) {
			log.notifyError('Failed to create parent folders.', e);
			return;
		}

		const body = remote.body ?? '';
		try {
			await writeTextFile(uri, body);
		} catch (e) {
			log.notifyError(`Failed to write file: ${uri.fsPath}`, e);
			return;
		}

		remote.body = '';
		const templateLink: TemplateLink = {
			type: 'Template',
			bodyHash: getHash(body),
			referencedTemplateIds: findAllTemplateReferences(body),
			template: remote,
			uriString: uri.toString(),
			org: session.profile.org,
		};
		LinkManager.addLink(templateLink);

		log.notifyInfo(`SUCCESS: Created ${vscode.workspace.asRelativePath(uri, true)}`);
	}
}
