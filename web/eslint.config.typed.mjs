import tseslint from 'typescript-eslint';
import baseConfig from './eslint.config.mjs';

// 类型感知审计档(npm run lint:typed):在门禁档之上对 src 与 vite.config.ts 开启 TypeScript 类型感知规则。
export default tseslint.config(
  ...baseConfig,
  {
    files: ['src/**/*.{ts,tsx}', 'vite.config.ts'],
    extends: [tseslint.configs.recommendedTypeChecked],
    languageOptions: {
      parserOptions: { projectService: true, tsconfigRootDir: import.meta.dirname },
    },
  },
);
