import type { PluginAPI } from './types.js';
import { registerAllTools } from './tools/register.js';

export const id = 'artemis';
export const name = 'Artemis - The Huntress';

export function register(api: PluginAPI) {
  registerAllTools(api);
  console.log('[Artemis] Plugin loaded successfully');
}
