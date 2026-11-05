// The planner's model, GPU layers and thinking defaults, and the fallback when the default
// planner is not installed. Every call to Ollama is mocked.

import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import {
  callPlanner, parseGpuLayers, plannerOptions, isMissingModel, DEFAULT_PLANNER_MODEL, MODEL,
} from './llm.mjs';
import { planSchema } from './planner.mjs';

function mockFetch(handler) {
  const real = globalThis.fetch;
  const bodies = [];
  globalThis.fetch = async (url, init) => {
    const body = JSON.parse(init.body);
    bodies.push(body);
    return handler(body, bodies.length);
  };
  return { bodies, restore: () => { globalThis.fetch = real; } };
}
const ok = (content) => ({ ok: true, json: async () => ({ message: { content } }) });
const missing = (name) => ({ ok: false, status: 404, text: async () => `{"error":"model '${name}' not found"}` });

test('parseGpuLayers tells unset from 0', () => {
  assert.equal(parseGpuLayers(undefined), null);
  assert.equal(parseGpuLayers(''), null);
  assert.equal(parseGpuLayers('auto'), null);
  assert.equal(parseGpuLayers('0'), 0);
  assert.equal(parseGpuLayers(0), 0);
  assert.equal(parseGpuLayers('12'), 12);
  assert.equal(parseGpuLayers('-1'), null);
  assert.equal(parseGpuLayers('1.5'), null);
  assert.equal(parseGpuLayers('lots'), null);
});

test('plannerOptions adds num_gpu only when layers are set, and keeps the shared context size', () => {
  assert.equal('num_gpu' in plannerOptions(null), false);
  assert.equal(plannerOptions(0).num_gpu, 0);
  assert.equal(plannerOptions('20').num_gpu, 20);
  assert.equal(plannerOptions(null).num_ctx, plannerOptions(0).num_ctx);
});

test('the default planner runs on the CPU with thinking off', async (t) => {
  if (process.env.PZ_PLANNER_MODEL || process.env.PZ_PLANNER_GPU_LAYERS || process.env.PZ_PLANNER_THINK) {
    t.skip('planner env is set on this machine');
    return;
  }
  const m = mockFetch(() => ok('{"goal":"x"}'));
  try {
    await callPlanner({ system: 's', user: 'u', schema: planSchema() });
  } finally {
    m.restore();
  }
  assert.equal(m.bodies[0].model, DEFAULT_PLANNER_MODEL);
  assert.equal(m.bodies[0].options.num_gpu, 0);
  assert.equal(m.bodies[0].think, false);
});

test('a model named in the call gets neither the CPU setting nor thinking off, unless asked', async (t) => {
  if (process.env.PZ_PLANNER_GPU_LAYERS || process.env.PZ_PLANNER_THINK) {
    t.skip('planner env is set on this machine');
    return;
  }
  const m = mockFetch(() => ok('{"goal":"x"}'));
  try {
    await callPlanner({ system: 's', user: 'u', schema: planSchema(), model: 'other-model' });
    await callPlanner({ system: 's', user: 'u', schema: planSchema(), model: 'other-model', gpuLayers: 8 });
    await callPlanner({ system: 's', user: 'u', schema: planSchema(), model: DEFAULT_PLANNER_MODEL, gpuLayers: null });
  } finally {
    m.restore();
  }
  assert.equal('num_gpu' in m.bodies[0].options, false);
  assert.equal(m.bodies[0].think, true);
  assert.equal(m.bodies[1].options.num_gpu, 8);
  assert.equal('num_gpu' in m.bodies[2].options, false, 'null leaves placement to Ollama');
});

test('env settings win over the defaults, and a pinned model drops the tuned ones', () => {
  const run = (envVars) => {
    const code = `import('./bridge/llm.mjs').then((m) => console.log(JSON.stringify({
      model: m.PLANNER_MODEL, layers: m.PLANNER_GPU_LAYERS, think: m.plannerThinkMode(m.PLANNER_MODEL) })))`;
    const r = spawnSync(process.execPath, ['-e', code], {
      cwd: new URL('..', import.meta.url),
      env: { ...process.env, PZ_PLANNER_MODEL: '', PZ_PLANNER_GPU_LAYERS: '', PZ_PLANNER_THINK: '', ...envVars },
      encoding: 'utf8',
    });
    assert.equal(r.status, 0, r.stderr);
    return JSON.parse(r.stdout);
  };
  assert.deepEqual(run({}), { model: DEFAULT_PLANNER_MODEL, layers: 0, think: 'off' });
  assert.deepEqual(run({ PZ_PLANNER_MODEL: 'mine:7b' }), { model: 'mine:7b', layers: null, think: 'auto' });
  assert.deepEqual(run({ PZ_PLANNER_MODEL: 'mine:7b', PZ_PLANNER_GPU_LAYERS: '10', PZ_PLANNER_THINK: 'off' }), { model: 'mine:7b', layers: 10, think: 'off' });
  assert.deepEqual(run({ PZ_PLANNER_GPU_LAYERS: '24', PZ_PLANNER_THINK: 'auto' }), { model: DEFAULT_PLANNER_MODEL, layers: 24, think: 'auto' });
});

test('isMissingModel reads Ollama\'s 404 and nothing else', () => {
  assert.equal(isMissingModel('ollama 404: {"error":"model \'x\' not found"}'), true);
  assert.equal(isMissingModel('ollama 500: out of memory'), false);
  assert.equal(isMissingModel('ollama 404: page not here'), false);
});

test('a machine without the default planner falls back to the menu model, and remembers', async (t) => {
  if (process.env.PZ_PLANNER_MODEL || MODEL === DEFAULT_PLANNER_MODEL) {
    t.skip('planner model is set on this machine');
    return;
  }
  const m = mockFetch((body) => (body.model === DEFAULT_PLANNER_MODEL ? missing(body.model) : ok('{"goal":"y"}')));
  try {
    const r = await callPlanner({ system: 's', user: 'u', schema: planSchema() });
    assert.equal(r.raw, '{"goal":"y"}');
    await callPlanner({ system: 's', user: 'u', schema: planSchema() });
  } finally {
    m.restore();
  }
  assert.deepEqual(m.bodies.map((b) => b.model), [DEFAULT_PLANNER_MODEL, MODEL, MODEL]);
  assert.equal('num_gpu' in m.bodies[1].options, false, 'the fallback model is not forced onto the CPU');
});
