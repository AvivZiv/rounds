// One generation step: the root of a topic, or the children of one node.
// Used by the laptop generator (Supabase) and by the Vite dev hook (local mode).
import { askClaude } from './claude-cli.mjs';
import { rootPrompt, expandPrompt, validateNodes } from './tree-prompt.mjs';

/**
 * @param {{topic:string, note?:string, level?:string}} item
 * @param {null | {node:{label,text,depth}, ancestors:{label,text}[], siblings:{label}[]}} ctx  null = build the root
 * @returns {Promise<{root?: {summary:string, topic_type:string}, nodes: {label,text,expandable,ord}[], model:string, ms:number}>}
 */
export async function generate(item, ctx) {
  if (!ctx) {
    const r = await askClaude(rootPrompt(item));
    return { root: { summary: String(r.data.summary || '').trim(), topic_type: String(r.data.topic_type || 'concept') }, nodes: validateNodes(r.data.nodes), model: r.model, ms: r.ms };
  }
  const r = await askClaude(expandPrompt({ ...item, ...ctx }));
  return { nodes: validateNodes(r.data.nodes), model: r.model, ms: r.ms };
}

/** Student profile line from settings, for the prompt. */
export function levelLine(settings) {
  const parts = [];
  if (settings?.career_interest) parts.push(settings.career_interest);
  if (settings?.emphasis?.length) parts.push('emphasise ' + settings.emphasis.join(', '));
  return parts.join('; ') || '';
}
