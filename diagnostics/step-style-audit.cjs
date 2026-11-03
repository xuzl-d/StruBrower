const fs = require('fs');
const file = process.argv[2];
let s = fs.readFileSync(file, 'latin1');
s = s.replace(/\r?\n\s*/g, '');

// id -> type for entity types of interest
const types = new Map();
for (const m of s.matchAll(/#(\d+)=([A-Z_0-9]+)\(/g)) types.set(m[1], m[2]);

const styled = [...s.matchAll(/#(\d+)=(OVER_RIDING_STYLED_ITEM|STYLED_ITEM)\(([^;]*?)\);/g)].map((m) => ({ id: m[1], kind: m[2], body: m[3] }));
console.log('styled entities parsed:', styled.length);
const kindCount = {};
const targetType = {};
const styleRefTargetType = {};
for (const st of styled) {
  kindCount[st.kind] = (kindCount[st.kind] || 0) + 1;
  const m = st.body.match(/\(([^)]*)\)\s*,\s*#(\d+)\s*,?/) || null;
  const mm = st.body.match(/,\(([^)]*)\)\s*,\s*#(\d+)/);
  const target = mm ? mm[2] : null;
  const styles = mm ? mm[1].replace(/#/g, '').trim() : null;
  const tt = target ? types.get(target) || 'UNKNOWN' : 'UNPARSED';
  targetType[tt] = (targetType[tt] || 0) + 1;
  if (styles) {
    for (const sid of styles.split(',')) {
      const stType = types.get(sid) || 'UNKNOWN';
      styleRefTargetType[stType] = (styleRefTargetType[stType] || 0) + 1;
    }
  }
  if (styled.indexOf(st) < 3) console.log(JSON.stringify(st));
}
console.log('kindCount', kindCount);
console.log('styled target entity types', targetType);
console.log('style assignment entity types', styleRefTargetType);

// distinct style chains -> colour refs
const colourRefs = new Map();
for (const m of s.matchAll(/#(\d+)=SURFACE_STYLE_USAGE\(([^;]*?)\);/g)) colourRefs.set(m[1], m[2]);

// how many colours per style; build style-assignment -> colour names
const psa = new Map();
for (const m of s.matchAll(/#(\d+)=PRESENTATION_STYLE_ASSIGNMENT\(([^;]*?)\);/g)) psa.set(m[1], m[2]);
console.log('PRESENTATION_STYLE_ASSIGNMENT count', psa.size);

// count faces total and how many faces appear as styled targets
const faceCount = (s.match(/=ADVANCED_FACE\(/g) || []).length;
console.log('ADVANCED_FACE count', faceCount);

// Which representation holds the MECH_DESIGN presentation rep
const mdgprs = [...s.matchAll(/#(\d+)=MECHANICAL_DESIGN_GEOMETRIC_PRESENTATION_REPRESENTATION\(([^;]*?)\);/g)];
for (const m of mdgprs) console.log('MDGPR id', m[1], 'body head', m[2].slice(0, 160));
