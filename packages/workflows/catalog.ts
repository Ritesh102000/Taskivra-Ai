import type { WorkflowDefinition, WorkflowDraft } from '../contracts/workflows';
import { parsePolicy, string, liveFail } from '../contracts/live-validation';
import { procedureForRecipe, renderProcedure } from './procedures';

/** Original, outcome-based starters. They grant no file sharing, uploads or peer access. */
export const WORKFLOW_RECIPES: WorkflowDefinition[] = [
  {
    id: 'competitor-brief', source: 'builtin', title: 'Compare competitors', category: 'business',
    description: 'Turn approved company pages into a useful comparison for a business decision.',
    outcome: 'A sourced comparison with differences, gaps and recommended next steps.',
    tools: ['Read approved websites', 'Write a private report'],
    inputs: [
      { id: 'focus', label: 'What are you comparing?', kind: 'multiline', required: true, placeholder: 'Compare the pricing, onboarding and features of these products for a small agency.' },
      { id: 'websites', label: 'Pages the agent may visit', kind: 'websites', required: true, placeholder: 'https://example.com/pricing\nOne HTTPS website or page per line' },
    ],
  },
  {
    id: 'data-report', source: 'builtin', title: 'Compare two CSV files', category: 'business',
    description: 'Assign two CSV inputs and get a checked comparison with reproducible calculations.',
    outcome: 'One report with findings, input coverage, calculation checks and limitations.',
    tools: ['Request private files', 'Run isolated code', 'Write private outputs'],
    inputs: [
      { id: 'question', label: 'What should the analysis answer?', kind: 'multiline', required: true, placeholder: 'Which products drove revenue this month, and what changed from last month?' },
      { id: 'files', label: 'What do the two periods represent?', kind: 'text', required: true, placeholder: 'Current month and prior month sales CSVs' },
    ],
  },
  {
    id: 'code-review', source: 'builtin', title: 'Review code files', category: 'developer',
    description: 'Review supplied source files for concrete bugs and suggest fixes with evidence.',
    outcome: 'Prioritized findings tied to supplied files, with proposed fixes and test coverage limits.',
    tools: ['Request private files', 'Run isolated code', 'Write a private report'],
    inputs: [
      { id: 'focus', label: 'What should the review focus on?', kind: 'multiline', required: true, placeholder: 'Check authentication, input validation and failure handling in these TypeScript files.' },
      { id: 'files', label: 'Files or test fixtures to request', kind: 'text', required: true, placeholder: 'Source files as plain text, plus relevant test fixtures' },
    ],
  },
  {
    id: 'website-review', source: 'builtin', title: 'Review a website', category: 'developer',
    description: 'Inspect permitted pages for visible usability, content and consistency problems.',
    outcome: 'A page-by-page review with observed issues, evidence and a prioritized improvement list.',
    tools: ['Read approved websites', 'Write a private report'],
    inputs: [
      { id: 'focus', label: 'Audience and review goals', kind: 'multiline', required: true, placeholder: 'Review the onboarding pages for new customers. Focus on clarity and missing information.' },
      { id: 'websites', label: 'Pages to inspect', kind: 'websites', required: true, placeholder: 'https://example.com\nhttps://example.com/help' },
    ],
  },
  {
    id: 'gmail-triage', source: 'builtin', title: 'Review unread Gmail', category: 'personal',
    description: 'Get a short list of important unread messages and actions worth your attention.',
    outcome: 'An unread-mail brief with urgency, next actions and explicit coverage limits.',
    tools: ['Read Gmail headers and snippets', 'Ask you to connect the account', 'Write a private report'],
    inputs: [
      { id: 'account', label: 'Gmail account', kind: 'email', required: true, placeholder: 'you@gmail.com' },
      { id: 'focus', label: 'What matters to you?', kind: 'multiline', required: true, placeholder: 'Prioritize deadlines, personal messages and payments that need my attention.' },
    ],
  },
  {
    id: 'decision-research', source: 'builtin', title: 'Research a decision', category: 'personal',
    description: 'Compare options against your needs using websites you choose.',
    outcome: 'A cited shortlist with trade-offs, uncertainties and a recommendation you can review.',
    tools: ['Read approved websites', 'Write a private report'],
    inputs: [
      { id: 'question', label: 'Decision, preferences and constraints', kind: 'multiline', required: true, placeholder: 'Compare these courses for a beginner with five hours a week. Include cost and prerequisites.' },
      { id: 'websites', label: 'Sources the agent may use', kind: 'websites', required: true, placeholder: 'https://example.com/course\nOne HTTPS page per line' },
    ],
  },
];
for (const recipe of WORKFLOW_RECIPES) recipe.procedure = procedureForRecipe(recipe);

export function workflowWebsites(value: string): { pages: string[]; origins: string[] } {
  const pages = value.split(/\r?\n/).map(line => line.trim()).filter(Boolean);
  if (pages.length > 20) liveFail('invalid_command', 'Use at most twenty page links.');
  const origins = [...new Set(pages.map(page => {
    let url: URL;
    try { url = new URL(page); } catch { return liveFail('invalid_command', 'Enter a complete HTTPS website or page on each line.'); }
    if (url.protocol !== 'https:' || url.username || url.password || url.port || page.length > 512 || url.hostname.endsWith('.localhost') || url.hostname === 'localhost' || url.hostname.endsWith('.local') || /^[\d.]+$/.test(url.hostname) || url.hostname.startsWith('[')) {
      return liveFail('invalid_command', 'Use public HTTPS websites without credentials, custom ports or IP addresses.');
    }
    return url.origin;
  }))];
  parsePolicy({ mode: 'read_only_browser', allowedOrigins: origins });
  return { pages, origins };
}

export function prepareWorkflow(recipe: WorkflowDefinition, rawValues: Record<string, string>): WorkflowDraft {
  if (!rawValues || typeof rawValues !== 'object' || Array.isArray(rawValues) || ![Object.prototype, null].includes(Object.getPrototypeOf(rawValues))) liveFail('invalid_command', 'Complete the workflow inputs.');
  const keys = new Set(recipe.inputs.map(input => input.id));
  if (Object.keys(rawValues).some(key => !keys.has(key))) liveFail('invalid_command', 'This workflow contains an unsupported input.');
  const values: Record<string, string> = Object.create(null);
  for (const input of recipe.inputs) {
    const value = rawValues[input.id] ?? input.defaultValue ?? '';
    if (typeof value !== 'string' || value.includes('\0') || Buffer.byteLength(value) > (input.id === 'objective' ? 8000 : input.id === 'criteria' ? 4000 : input.kind === 'websites' ? 4096 : 1600)) liveFail('invalid_command', `${input.label} is too long or invalid.`);
    if (input.required && !value.trim()) liveFail('invalid_command', `Complete “${input.label}” before saving the task.`);
    values[input.id] = value.trim();
  }
  const { pages, origins } = workflowWebsites(values.websites || '');
  if (recipe.procedure) {
    const procedure = recipe.procedure;
    const account = procedure.accountField ? values[procedure.accountField].toLowerCase() : undefined;
    const policy = parsePolicy({ mode: procedure.mode, allowedOrigins: account ? ['https://mail.google.com', 'https://accounts.google.com'] : origins, ...(account ? { mailAccount: account } : {}) });
    const fields = { ...values, sources: pages.join('\n') };
    return { objective: string(renderProcedure(procedure.objectiveTemplate, fields), 8000), completionCriteria: string(renderProcedure(procedure.completionTemplate, fields), 4000), policy };
  }
  if (recipe.source === 'saved') {
    const saved = recipe.savedDraft!;
    return {
      objective: string(values.objective, 8000), completionCriteria: string(values.criteria, 4000),
      policy: parsePolicy({ mode: saved.policy.mode, allowedOrigins: origins, ...(saved.policy.mailAccount ? { mailAccount: values.account.toLowerCase() } : {}) }),
    };
  }
  let objective: string;
  let criteria = recipe.outcome;
  let policy = parsePolicy({ mode: ['data-report', 'code-review'].includes(recipe.id) ? 'workspace' : 'read_only_browser', allowedOrigins: origins });
  const sources = `Owner-approved source pages:\n${pages.join('\n')}\nCite exact pages you actually inspect. Ask for clarification if these sources cannot support the requested outcome. Do not submit forms or change website data.`;
  switch (recipe.id) {
    case 'competitor-brief': objective = `Prepare a competitor comparison.\n${values.focus}\n${sources}`; break;
    case 'website-review': objective = `Review the visible content and usability of the supplied pages.\n${values.focus}\n${sources}\nDistinguish observed problems from suggestions. Do not claim interactive, accessibility or performance tests you did not execute.`; break;
    case 'decision-research': objective = `Research this decision:\n${values.question}\n${sources}\nState source dates when available, missing information and any uncertain recommendation.`; break;
    case 'data-report':
      objective = `Analyze the owner's data to answer:\n${values.question}\nFiles the owner expects to provide: ${values.files}.\nRequest the required files using specific file slots before analysis. Use CSV, JSON or supported spreadsheet files; preserve missing-file blockers. Run reproducible calculations in the isolated code container. Do not invent data or request host paths. If a runtime package is unavailable, ask through the dependency request flow. Keep all inputs and outputs private.`;
      criteria += ' Include the actual rows or coverage analyzed, assumptions and calculation checks. Missing data must be requested or explicitly excluded with owner acceptance.';
      break;
    case 'code-review':
      objective = `Review source files for the owner's stated concerns:\n${values.focus}\nRequest these files and fixtures: ${values.files}.\nAsk for source as supported plain-text files; there is no automatic repository checkout or access to the owner's filesystem. Tie findings to supplied filenames and observed code. Run tests only in the isolated offline code container when the required runtime is available. Do not claim a proposed test was executed. Keep reports and fixes private.`;
      break;
    case 'gmail-triage':
      policy = parsePolicy({ mode: 'read_only_browser', allowedOrigins: ['https://mail.google.com', 'https://accounts.google.com'], mailAccount: values.account.toLowerCase() });
      objective = `Review important unread email for ${policy.mailAccount}.\nPriorities: ${values.focus}\nUse the supported read-only Gmail connection or ask the owner to connect the exact account. Summarize observed headers and snippets, distinguish actionable mail from promotions, and include concrete next actions. Preserve unread status; do not send, archive, delete, open attachments or claim to have read full bodies.`;
      criteria += ' State messages returned, the per-read limit, whether more unread messages were excluded and whether summaries were truncated. Do not claim complete inbox coverage unless verified.';
      break;
    default: return liveFail('not_found', 'Choose an available workflow.');
  }
  return { objective: string(objective, 8000), completionCriteria: string(criteria, 4000), policy };
}
