// Prompts for the knowledge tree. Shared by the laptop generator and tests.

export const SYSTEM = `You write a knowledge tree for a medical student on hospital rounds.
A node is ONE or TWO sentences, hard maximum 35 words, with a 1-4 word label. Count the words. A student reads a node in five seconds, gets the gist, and taps it to go deeper; depth belongs in child nodes, never in the node itself.
Nodes must be concrete, correct, and pitched at final-year medical student level: numbers, names, criteria, doses where they matter.
Never pad. Never repeat the parent's text. Never add disclaimers or advice to consult sources.
Each node answers one aspect; together the siblings cover the WHOLE scope of the parent, in the order a clinician would teach it.
Output only JSON that matches the schema given in the user message, nothing else.`;

const ROOT_ORDERS = {
  disease: ['Background', 'Pathophysiology', 'Presentation', 'Diagnosis', 'Differential diagnosis', 'Treatment', 'Complications', 'Prognosis'],
  procedure: ['What it is', 'Indications', 'Technique', 'Interpretation', 'Pitfalls', 'Contraindications'],
  drug: ['Class & mechanism', 'Indications', 'Dosing', 'Adverse effects', 'Interactions', 'Monitoring', 'Reversal'],
  approach: ['Framework', 'Dangerous causes', 'Common causes', 'History', 'Examination', 'Investigations', 'Initial management'],
  concept: ['Definition', 'Mechanism', 'Why it matters', 'Clinical use', 'Pitfalls'],
};

export function rootPrompt({ topic, note, level }) {
  return `Topic: ${topic}${note ? `\nContext from the student: ${note}` : ''}${level ? `\nStudent profile: ${level}` : ''}

Step 1: classify the topic as one of: disease | procedure | drug | approach | concept.
Step 2: write the top-level nodes using this order for the type (drop any that genuinely do not apply, add at most one if essential):
${Object.entries(ROOT_ORDERS).map(([k, v]) => `  ${k}: ${v.join(' → ')}`).join('\n')}
MULTI-PART TOPICS. If the topic names two or more things (e.g. "Dix-Hallpike vs HINTS", "Dix-Hallpike and Epley for BPPV", "types of MI"), do NOT use the type order above. Instead:
  - exactly one top-level node PER named thing (label = just its name, e.g. "Dix-Hallpike"), each expandable. Its text is the 1-2 sentence gist of that thing. Do NOT split a thing into several top-level nodes ("X: when", "X: technique"): when, why, how and interpretation are written later as its children;
  - then one node that answers what the student asked about them together (e.g. "When to use which", "How they differ"), if the topic implies one;
  - nothing else at the top level.
Answer every part of the student's wording: if the topic says "when do you perform each and why", the comparison node must say when and why for each, and each thing's own node must point to its use.

Schema:
{"topic_type":"disease|procedure|drug|approach|concept","summary":"one sentence saying what this is","nodes":[{"label":"...","text":"...","expandable":true|false}]}
"expandable" is false only when there is genuinely nothing more a student would need below the node.`;
}

export function expandPrompt({ topic, note, level, ancestors, node, siblings }) {
  const path = ancestors.map((a) => `${a.label}: ${a.text}`).join('\n  > ');
  return `Topic: ${topic}${note ? `\nContext from the student: ${note}` : ''}${level ? `\nStudent profile: ${level}` : ''}
Path so far:
  > ${path}
Node to expand:
  ${node.label}: ${node.text}
Its sibling nodes (do NOT cover these; stay inside the node above): ${siblings.map((s) => s.label).join(', ') || 'none'}

Write 3-7 child nodes that together give the full scope of "${node.label}" for this topic, one level more detailed than the node, in teaching order.
If "${node.label}" is a bedside test, examination manoeuvre or procedure, the children MUST include "How to perform" (positioning and steps), "When to use" (indications), and "Interpreting the result" (what a positive / abnormal finding looks like and means).
If it is one of several things the topic compares, cover it fully on its own terms; the comparison lives elsewhere in the tree. Depth ${node.depth + 1}: ${node.depth + 1 >= 3 ? 'be specific (exact criteria, doses, numbers, names).' : 'organise the aspects; details come in deeper levels.'}

Schema:
{"nodes":[{"label":"...","text":"...","expandable":true|false}]}`;
}

/** Pull the first JSON object out of a model reply (tolerates code fences / stray text). */
export function parseJSON(text) {
  const s = String(text ?? '');
  const start = s.indexOf('{');
  const end = s.lastIndexOf('}');
  if (start < 0 || end < start) throw new Error('no JSON in reply');
  return JSON.parse(s.slice(start, end + 1));
}

export function validateNodes(nodes) {
  if (!Array.isArray(nodes) || nodes.length < 2) throw new Error('too few nodes');
  return nodes.slice(0, 10).map((n, i) => {
    const label = String(n.label || '').trim().slice(0, 60);
    const text = String(n.text || '').trim().replace(/\s+/g, ' ');
    if (!label || !text) throw new Error(`node ${i} missing label/text`);
    // Keep at most two sentences / ~45 words even if the model overruns.
    // Sentence ends: . ! ? followed by a space and a capital/quote/paren, or end of text (not decimals like 0.5).
    const sentences = text.split(/(?<=[.!?])\s+(?=[A-Z"“(])/);
    const two = sentences.slice(0, 2).join(' ').trim();
    return { label, text: two.split(/\s+/).slice(0, 45).join(' '), expandable: n.expandable !== false, ord: i };
  });
}
