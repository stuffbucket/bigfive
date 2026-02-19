/**
 * Extracts questions and result templates from @bigfive-org packages
 * into static JSON files that can be bundled into the client app.
 * After extraction, no server or npm packages are needed at runtime.
 */
import { createRequire } from 'module';
import { writeFileSync, mkdirSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';

const require = createRequire(import.meta.url);
const __dirname = dirname(fileURLToPath(import.meta.url));
const outDir = join(__dirname, '..', 'src', 'data');

mkdirSync(outDir, { recursive: true });

// Extract questions
const questions = require('@bigfive-org/questions');
const qInfo = questions.getInfo();
const langs = qInfo.languages.map(l => l.id);

const questionsData = {};
for (const lang of langs) {
  try {
    questionsData[lang] = questions.getItems(lang);
  } catch {
    // Language not available for questions, skip
  }
}

writeFileSync(
  join(outDir, 'questions.json'),
  JSON.stringify(questionsData, null, 0)
);

// Extract result templates
const results = require('@bigfive-org/results');
const rInfo = results.getInfo();
const rLangs = rInfo.languages.map(l => l.id);

const resultsData = {};
for (const lang of rLangs) {
  try {
    resultsData[lang] = results.getTemplate(lang);
  } catch {
    // Language not available for results, skip
  }
}

writeFileSync(
  join(outDir, 'results.json'),
  JSON.stringify(resultsData, null, 0)
);

// Extract language metadata
const allLangs = {};
for (const l of qInfo.languages) {
  if (questionsData[l.id] && resultsData[l.id]) {
    allLangs[l.id] = l.text;
  }
}

writeFileSync(
  join(outDir, 'languages.json'),
  JSON.stringify(allLangs, null, 2)
);

console.log(`Extracted ${Object.keys(questionsData).length} question languages`);
console.log(`Extracted ${Object.keys(resultsData).length} result languages`);
console.log(`${Object.keys(allLangs).length} languages have both questions and results`);
