import type { PluginAPI } from '../types.js';
import type { ArtemisDB } from '../db/database.js';
import { text } from './helpers.js';

export function registerPoolTools(api: PluginAPI, db: ArtemisDB): void {

  api.registerTool({
    name: 'artemis_company_add',
    description: 'Add a company to the hunting pool. Artemis will scan its career page for job postings.',
    parameters: {
      name: { type: 'string', description: 'Company name (e.g., "Google", "Stripe")', required: true },
      careers_url: { type: 'string', description: 'URL of the company career/jobs page', required: true },
    },
    execute: async (_id, params) => {
      const name = params.name as string;
      const careersUrl = params.careers_url as string;

      if (!name || !careersUrl) {
        return text({ content: '', error: 'Both name and careers_url are required' });
      }

      const company = db.createCompany(name, careersUrl);
      return text({
        content: `Added **${company.name}** to the hunting pool.\n\n` +
          `- **ID:** ${company.id.slice(0, 8)}\n` +
          `- **Careers URL:** ${company.careers_url}\n` +
          `- **Status:** Active\n\n` +
          `This company will be included in the next scan.`,
      });
    },
  });

  api.registerTool({
    name: 'artemis_company_remove',
    description: 'Remove a company from the hunting pool. Existing job postings from this company are preserved.',
    parameters: {
      company_id: { type: 'string', description: 'Company ID (full UUID or short 8-char prefix)', required: true },
    },
    execute: async (_id, params) => {
      const companyId = params.company_id as string;
      const company = db.getCompany(companyId);

      if (!company) {
        return text({ content: '', error: `Company not found: ${companyId}` });
      }

      const name = company.name;
      db.removeCompany(companyId);
      return text({
        content: `Removed **${name}** from the hunting pool. Existing job postings are preserved.`,
      });
    },
  });

  api.registerTool({
    name: 'artemis_company_list',
    description: 'List all companies in the hunting pool with their status and scan stats.',
    parameters: {},
    execute: async () => {
      const companies = db.getAllCompanies();

      if (companies.length === 0) {
        return text({
          content: 'No companies in the hunting pool yet.\n\nUse `artemis_company_add` to add companies to track.',
        });
      }

      const active = companies.filter(c => c.is_active);
      const inactive = companies.filter(c => !c.is_active);

      let content = `**Hunting Pool — ${companies.length} companies** (${active.length} active, ${inactive.length} paused)\n\n`;

      if (active.length > 0) {
        content += '**Active:**\n';
        for (const c of active) {
          const jobCount = db.getJobPostingsByCompany(c.id).length;
          const recentScans = db.getScanLogsByCompany(c.id);
          const lastScan = recentScans.length > 0 ? recentScans[0].scanned_at.slice(0, 10) : 'never';
          content += `- **${c.name}** (${c.id.slice(0, 8)}) — ${jobCount} jobs tracked, last scan: ${lastScan}\n`;
          content += `  ${c.careers_url}\n`;
        }
      }

      if (inactive.length > 0) {
        content += '\n**Paused:**\n';
        for (const c of inactive) {
          content += `- ~~${c.name}~~ (${c.id.slice(0, 8)}) — paused\n`;
        }
      }

      return text({ content });
    },
  });

  api.registerTool({
    name: 'artemis_company_update',
    description: 'Update a company in the hunting pool — change name, URL, or toggle active/paused.',
    parameters: {
      company_id: { type: 'string', description: 'Company ID', required: true },
      name: { type: 'string', description: 'New company name' },
      careers_url: { type: 'string', description: 'New careers page URL' },
      is_active: { type: 'string', description: 'Set active status: "true" or "false"' },
    },
    execute: async (_id, params) => {
      const companyId = params.company_id as string;
      const company = db.getCompany(companyId);

      if (!company) {
        return text({ content: '', error: `Company not found: ${companyId}` });
      }

      const updates: { name?: string; careers_url?: string; is_active?: boolean } = {};
      if (params.name) updates.name = params.name as string;
      if (params.careers_url) updates.careers_url = params.careers_url as string;
      if (params.is_active !== undefined) {
        updates.is_active = (params.is_active as string) === 'true';
      }

      db.updateCompany(companyId, updates);

      const updated = db.getCompany(companyId)!;
      return text({
        content: `Updated **${updated.name}**:\n\n` +
          `- **Careers URL:** ${updated.careers_url}\n` +
          `- **Status:** ${updated.is_active ? 'Active' : 'Paused'}\n`,
      });
    },
  });
}
