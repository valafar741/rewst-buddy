/** Prefix for org rows in the Linked templates tree (context menu + command args). */
export const LINKED_TEMPLATES_ORG_CONTEXT_PREFIX = 'linkedTemplatesOrg:' as const;

export function linkedOrgTreeContextValue(orgId: string): string {
	return LINKED_TEMPLATES_ORG_CONTEXT_PREFIX + Buffer.from(orgId, 'utf8').toString('base64url');
}

export function parseOrgIdFromLinkedTemplatesTreeContext(contextValue: string | undefined): string | undefined {
	if (!contextValue?.startsWith(LINKED_TEMPLATES_ORG_CONTEXT_PREFIX)) {
		return undefined;
	}
	try {
		return Buffer.from(contextValue.slice(LINKED_TEMPLATES_ORG_CONTEXT_PREFIX.length), 'base64url').toString(
			'utf8',
		);
	} catch {
		return undefined;
	}
}
