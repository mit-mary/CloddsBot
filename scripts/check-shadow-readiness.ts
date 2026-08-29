import { assertShadowReady } from '../src/safety/shadow-readiness.js';

const result = assertShadowReady();
process.stdout.write(`SHADOW_READINESS_OK ${JSON.stringify(result.evidence)}\n`);
