import { LinkManager, SyncManager, TemplateLink } from '@models';
import { uriExists } from '@utils';
import vscode from 'vscode';
import { linkedOrgTreeContextValue } from './linkedTemplatesTreeContext';

type LinkedTemplatesTreeNode = OrgGroupNode | TemplateLeafNode;

class OrgGroupNode {
	readonly kind = 'org' as const;
	constructor(
		public readonly orgId: string,
		public readonly orgName: string,
		public readonly links: TemplateLink[],
	) {}
}

class TemplateLeafNode {
	readonly kind = 'template' as const;
	readonly resourceUri: vscode.Uri;
	constructor(
		public readonly link: TemplateLink,
		public readonly localFileMissing: boolean,
	) {
		this.resourceUri = vscode.Uri.parse(link.uriString);
	}
}

function linksInWorkspace(links: TemplateLink[]): TemplateLink[] {
	return links.filter(link => vscode.workspace.getWorkspaceFolder(vscode.Uri.parse(link.uriString)) !== undefined);
}

function groupByOrg(links: TemplateLink[]): Map<string, { name: string; links: TemplateLink[] }> {
	const map = new Map<string, { name: string; links: TemplateLink[] }>();
	for (const link of links) {
		const id = link.org.id;
		let entry = map.get(id);
		if (!entry) {
			entry = { name: link.org.name, links: [] };
			map.set(id, entry);
		}
		entry.links.push(link);
	}
	for (const entry of map.values()) {
		entry.links.sort((a, b) => a.template.name.localeCompare(b.template.name));
	}
	return map;
}

export class LinkedTemplatesTreeDataProvider
	implements vscode.TreeDataProvider<LinkedTemplatesTreeNode>, vscode.Disposable
{
	private changeEmitter = new vscode.EventEmitter<LinkedTemplatesTreeNode | undefined | null | void>();
	readonly onDidChangeTreeData = this.changeEmitter.event;
	private disposables: vscode.Disposable[] = [];

	constructor() {
		this.disposables.push(LinkManager.onLinksSaved(() => this.changeEmitter.fire()));
		this.disposables.push(SyncManager.onOrgLinkedTemplateBulkSyncUiChanged(() => this.changeEmitter.fire()));
		this.disposables.push(vscode.workspace.onDidChangeWorkspaceFolders(() => this.changeEmitter.fire()));
		this.disposables.push(
			vscode.workspace.onDidCreateFiles(() => this.changeEmitter.fire()),
			vscode.workspace.onDidDeleteFiles(() => this.changeEmitter.fire()),
		);
	}

	dispose(): void {
		this.disposables.forEach(d => d.dispose());
		this.changeEmitter.dispose();
	}

	getTreeItem(element: LinkedTemplatesTreeNode): vscode.TreeItem {
		switch (element.kind) {
			case 'org': {
				const label = `${element.orgName} (${element.links.length})`;
				const item = new vscode.TreeItem(label, vscode.TreeItemCollapsibleState.Collapsed);
				const bulkActive = SyncManager.isOrgLinkedTemplateBulkSyncActive(element.orgId);
				item.iconPath = new vscode.ThemeIcon(bulkActive ? 'sync~spin' : 'organization');
				item.contextValue = linkedOrgTreeContextValue(element.orgId);
				return item;
			}
			case 'template': {
				const item = new vscode.TreeItem(element.link.template.name, vscode.TreeItemCollapsibleState.None);
				item.id = `rewst-linked-template:${element.resourceUri.toString()}`;
				item.resourceUri = element.resourceUri;
				const rel = vscode.workspace.asRelativePath(element.resourceUri, false);
				if (element.localFileMissing) {
					item.iconPath = new vscode.ThemeIcon('debug-disconnect');
					item.description = rel ? `${rel} (missing)` : 'Local file missing';
					item.command = undefined;
					const tip = new vscode.MarkdownString();
					tip.appendMarkdown(`**${element.link.template.name}**\n\n`);
					tip.appendMarkdown(
						`Local file is missing. Right-click **Create local file from link** to fetch the template and create folders.`,
					);
					item.tooltip = tip;
					item.contextValue = 'linkedTemplateMissing';
				} else {
					item.iconPath = new vscode.ThemeIcon('file-code');
					if (rel && rel !== element.link.template.name) {
						item.description = rel;
					}
					item.command = {
						command: 'vscode.open',
						title: 'Open Template',
						arguments: [element.resourceUri],
					};
					item.tooltip = element.link.template.name;
					item.contextValue = 'bundleTemplate';
				}
				return item;
			}
		}
	}

	getChildren(element?: LinkedTemplatesTreeNode): Thenable<LinkedTemplatesTreeNode[]> {
		if (element) {
			if (element.kind === 'org') {
				return Promise.all(
					element.links.map(async link => {
						const uri = vscode.Uri.parse(link.uriString);
						const localFileMissing = !(await uriExists(uri));
						return new TemplateLeafNode(link, localFileMissing);
					}),
				);
			}
			return Promise.resolve([]);
		}

		const inWorkspace = linksInWorkspace(LinkManager.getAllTemplateLinks());
		const map = groupByOrg(inWorkspace);
		const orgNodes = [...map.entries()]
			.sort((a, b) => a[1].name.localeCompare(b[1].name))
			.map(([orgId, { name, links }]) => new OrgGroupNode(orgId, name, links));

		return Promise.resolve(orgNodes);
	}
}
