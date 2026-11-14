// Prints a root tree and one expansion for a topic, to judge quality before wiring the UI.
//   node tools/tree-test.mjs "Warfarin reversal" [label-to-expand]
import { askClaude } from './claude-cli.mjs';
import { rootPrompt, expandPrompt, validateNodes } from './tree-prompt.mjs';

const topic = process.argv[2] || 'Hyponatremia';
const expandLabel = process.argv[3];
const t0 = Date.now();
const root = await askClaude(rootPrompt({ topic }));
const nodes = validateNodes(root.data.nodes);
console.log(`# ${topic}  [${root.data.topic_type}]  (${root.ms} ms, ${root.usage?.output_tokens} out tok)\n${root.data.summary}\n`);
for (const n of nodes) console.log(`${n.ord + 1}. ${n.label}${n.expandable ? '' : ' ·'} — ${n.text}`);
if (expandLabel) {
  const node = nodes.find((n) => n.label.toLowerCase().startsWith(expandLabel.toLowerCase())) || nodes[0];
  const r = await askClaude(expandPrompt({ topic, ancestors: [{ label: topic, text: root.data.summary }], node: { ...node, depth: 1 }, siblings: nodes.filter((n) => n !== node) }));
  console.log(`\n## ${node.label}  (${r.ms} ms)`);
  for (const n of validateNodes(r.data.nodes)) console.log(`  ${n.ord + 1}. ${n.label}${n.expandable ? '' : ' ·'} — ${n.text}`);
}
console.log(`\n(${((Date.now() - t0) / 1000).toFixed(1)} s total)`);
