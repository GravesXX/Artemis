import type { PluginAPI } from '../types.js';
import { ArtemisDB } from '../db/database.js';
import { registerPoolTools } from './pool-tools.js';
import { registerHuntTools } from './hunt-tools.js';
import { registerReportTools } from './report-tools.js';
import { registerApplyTools } from './apply-tools.js';
import { registerTrackTools } from './track-tools.js';
import { registerEmailTools } from './email-tools.js';
import path from 'path';
import os from 'os';

export function registerAllTools(api: PluginAPI): void {
  const vaultPath = path.join(os.homedir(), 'Documents', 'Obsidian Vault');
  const db = new ArtemisDB(vaultPath);

  registerPoolTools(api, db);                              // 4 tools
  registerHuntTools(api, db);                              // 4 tools
  registerReportTools(api, db);                            // 2 tools
  registerApplyTools(api, db);                             // 7 tools (5 apply + 2 credential)
  registerTrackTools(api, db);                             // 4 tools
  registerEmailTools(api, db);                             // 3 tools
  // Total: 24 tools
}
