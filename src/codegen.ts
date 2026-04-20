import type { CodegenConfig } from '@graphql-codegen/cli';

const config: CodegenConfig = {
	schema: 'https://api.rewst.asia/graphql',
	documents: ['src/**/*.graphql'],
	generates: {
		'src/sessions/graphql/sdk.ts': {
			plugins: ['typescript', 'typescript-operations', 'typescript-graphql-request'],
			config: {
				gqlImport: 'graphql-request#gql',
			},
		},
	},
	emitLegacyCommonJSImports: false,
};

export default config;
