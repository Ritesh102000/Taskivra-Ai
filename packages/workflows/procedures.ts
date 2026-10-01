import { createHash } from 'node:crypto';
import type { WorkflowDefinition, WorkflowProcedure } from '../contracts/workflows';
import { liveFail } from '../contracts/live-validation';

function canonical(value: unknown): unknown {
  return Array.isArray(value) ? value.map(canonical) : value && typeof value === 'object' ? Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([key, item]) => [key, canonical(item)])) : value;
}
export function procedureVersion(procedure: Omit<WorkflowProcedure, 'versionId'>): string {
  return createHash('sha256').update(JSON.stringify(canonical(procedure))).digest('hex');
}
const sources = 'Owner-approved source pages:\n{{sources}}\nCite exact pages you actually inspect. Ask for clarification if these sources cannot support the requested outcome. Do not submit forms or change website data.';

/** Original procedure snapshots; source text is data, and never extends the task's tool grants. */
export function procedureForRecipe(recipe: WorkflowDefinition): WorkflowProcedure {
  const common = { schemaVersion: 1 as const, inputs: structuredClone(recipe.inputs), mode: 'read_only_browser' as const, fileSlots: [], output: { format: 'markdown' as const, filename: 'report.md', sections: ['Findings', 'Sources and coverage', 'Limitations'] }, completionTemplate: recipe.outcome };
  let data: Omit<WorkflowProcedure, 'versionId'>;
  switch (recipe.id) {
    case 'data-report': data = {
      ...common, mode: 'workspace', requiredCapabilities: ['code'],
      fileSlots: [
        { key: 'current_data', label: 'Current-period CSV', required: true, constraints: { formats: ['csv'], minBytes: 1, maxBytes: 1048576, csv: { requiredColumns: [], minRows: 1, maxRows: 10000 } } },
        { key: 'comparison_data', label: 'Comparison-period CSV', required: true, constraints: { formats: ['csv'], minBytes: 1, maxBytes: 1048576, csv: { requiredColumns: [], minRows: 1, maxRows: 10000 } } },
      ],
      objectiveTemplate: 'Analyze the owner’s two assigned CSV inputs to answer:\n{{question}}\nOwner’s description of the inputs: {{files}}.\nUse the exact versions assigned to current_data and comparison_data, as identified in the task’s file-slot context. Do not guess their roles from filenames. Check compatible column meanings and units before comparing. If they cannot answer the question, request clarification; do not invent missing columns or values. Run reproducible calculations in the isolated offline code container. Keep inputs and results private.\nProduce one report.md containing Findings, Coverage, Calculation checks and Limitations. Include a reproducible calculation appendix in the same report; supporting files are optional and must not replace the required report.',
      completionTemplate: 'A private report.md with Findings, Coverage, Calculation checks and Limitations. Identify both exact input versions, actual rows and columns analyzed, comparison assumptions, and executed calculation checks. Include reproducible calculation code in an appendix. Distinguish shape validation from semantic relevance; missing or incompatible data requires clarification or explicitly approved reduced scope.',
      output: { format: 'markdown', filename: 'report.md', sections: ['Findings', 'Coverage', 'Calculation checks', 'Limitations'] },
      example: { label: 'Illustrative example — no sample files are imported or analyzed', inputs: { question: 'Which product values changed between these two periods?', files: 'Current-period and comparison-period CSVs with product and value columns.' }, output: '# Findings\nA comparison grounded in the supplied rows.\n\n# Coverage\nThe exact two inputs and rows analyzed.\n\n# Calculation checks\nExecuted totals, comparison method and reproducible code.\n\n# Limitations\nMissing values, differing units and assumptions.' },
    }; break;
    case 'code-review': data = { ...common, mode: 'workspace', requiredCapabilities: [], objectiveTemplate: 'Review supplied source files for the owner’s concerns:\n{{focus}}\nRequest these files and fixtures: {{files}}.\nAsk for source as supported plain-text files; there is no automatic repository checkout or host filesystem access. Tie findings to supplied filenames and observed code. Run tests only in the isolated offline code container when its runtime is available. Never claim a proposed test was executed. Keep reports and fixes private.', example: { label: 'Illustrative review format', inputs: { focus: 'Check input validation and failure handling.', files: 'Source text and small JSON test fixtures.' }, output: '# Findings\nPrioritized issues tied to observed source.\n\n# Sources and coverage\nFiles reviewed and checks actually run.\n\n# Limitations\nMissing dependencies and unexecuted tests.' } }; break;
    case 'gmail-triage': data = { ...common, requiredCapabilities: ['gmail'], accountField: 'account', objectiveTemplate: 'Review important unread email for {{account}}.\nPriorities: {{focus}}\nUse the read-only Gmail connection for the exact account. Start with observed unread headers and snippets, distinguish actionable mail from promotions and include concrete next actions. Only if the task policy explicitly allows detailed read-only review, search further and read selected full threads or import selected safe attachments when needed for the requested review. Preserve unread status; do not send, archive, or delete mail. Describe only content actually read and state every coverage or truncation limit.', completionTemplate: recipe.outcome + ' State messages returned, the per-read limit, whether more unread messages were excluded and whether summaries were truncated. Never claim complete inbox coverage unless verified.', example: { label: 'Illustrative mail brief — not real messages', inputs: { account: 'you@gmail.com', focus: 'Deadlines and direct questions requiring my reply.' }, output: '# Findings\nImportant observed messages and suggested next actions.\n\n# Sources and coverage\nReturned message count, up-to-50 limit, headers/snippets only and excluded messages.\n\n# Limitations\nFull bodies and attachments were not read.' } }; break;
    case 'competitor-brief': data = { ...common, requiredCapabilities: ['browser'], sourcesField: 'websites', objectiveTemplate: 'Prepare a competitor comparison.\n{{focus}}\n' + sources, example: { label: 'Illustrative comparison format', inputs: { focus: 'Compare pricing, onboarding and supported workflows.', websites: 'https://example.com/pricing' }, output: '# Findings\nA sourced comparison of the chosen products.\n\n# Sources and coverage\nExact pages inspected and dates where available.\n\n# Limitations\nClaims that could not be independently checked.' } }; break;
    case 'website-review': data = { ...common, requiredCapabilities: ['browser'], sourcesField: 'websites', objectiveTemplate: 'Review visible content and usability of the supplied pages.\n{{focus}}\n' + sources + '\nDistinguish observed problems from suggestions. Do not claim interactive, accessibility or performance tests you did not execute.', example: { label: 'Illustrative website review format', inputs: { focus: 'Review clarity for a first-time customer.', websites: 'https://example.com/help' }, output: '# Findings\nPage-specific observations and recommended changes.\n\n# Sources and coverage\nPages actually observed.\n\n# Limitations\nUnexecuted accessibility and interaction tests.' } }; break;
    case 'decision-research': data = { ...common, requiredCapabilities: ['browser'], sourcesField: 'websites', objectiveTemplate: 'Research this decision:\n{{question}}\n' + sources + '\nState source dates where available, missing information and uncertainty in the recommendation.', example: { label: 'Illustrative decision brief format', inputs: { question: 'Compare courses for a beginner with five hours per week.', websites: 'https://example.com/course' }, output: '# Findings\nA shortlist against the owner’s criteria.\n\n# Sources and coverage\nThe exact sources inspected.\n\n# Limitations\nUnknown or dated claims and remaining trade-offs.' } }; break;
    default: return liveFail('invalid_command', 'This workflow procedure is unavailable.');
  }
  return { ...data, versionId: procedureVersion(data) };
}

export function readProcedure(json: string): WorkflowProcedure {
  try {
    const value = JSON.parse(json) as WorkflowProcedure;
    const { versionId, ...definition } = value;
    if (value.schemaVersion !== 1 || typeof versionId !== 'string' || !/^[a-f0-9]{64}$/.test(versionId) || procedureVersion(definition) !== versionId || !Array.isArray(value.inputs) || !Array.isArray(value.fileSlots) || !Array.isArray(value.requiredCapabilities) || typeof value.objectiveTemplate !== 'string' || typeof value.completionTemplate !== 'string') throw Error('invalid');
    return value;
  } catch { return liveFail('invalid_command', 'This saved workflow definition is damaged or unsupported. Existing tasks are preserved.'); }
}

export function renderProcedure(template: string, values: Record<string, string>): string {
  return template.replace(/\{\{([a-z][a-z0-9_]*)\}\}/g, (_, key: string) => {
    if (!Object.hasOwn(values, key)) return liveFail('invalid_command', 'This workflow references an unavailable input.');
    return values[key];
  });
}
