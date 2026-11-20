import { defineConfig } from '@neon/config/v1';

export default defineConfig({
  // Declare your Neon services here
  preview: {
    realtime: true,
  },
  auth: true,
  aiGateway: true,
  functions: {
    hello: {
      name: 'Hello World',
      source: './hello.ts',
      env: {
        NEON_FUNCTION_API_KEY: {
          value: process.env.NEON_FUNCTION_API_KEY,
          required: true,
        },
      },
    },
  },
  // Branch policy: per-branch tuning
  branch: (branch) => {
    if (branch.isDefault) {
      // Default branch: no overrides, uses project defaults
      return {};
    }
    if (!branch.exists) {
      // New non-default branches: auto-expire
      // Run `neon checkout <name>` to create a new branch with these settings
      return { ttl: '7d' };
    }
    // Existing branch: no changes
    return {};
  },
});
