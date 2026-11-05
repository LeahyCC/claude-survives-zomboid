// Turn a model reply into one intent line the mod can run.
// The mod owns the verbs. A bad type becomes WAIT, it never becomes a new verb.

export const ACTIONS = ['MOVE', 'LOOT', 'EAT', 'DRINK', 'EQUIP', 'CLOSEDOOR', 'CONCEAL', 'BREAKIN', 'STOP', 'WAIT'];

const PERSONA = `You play one survivor in Project Zomboid. Reply with ONE JSON object and nothing else.
A fast reflex already fights or flees any zombie inside 10 tiles. You are only asked when none is that close. Pick the next step, not each swing.

Senses: hunger, thirst, fatigue, panic are 0 to 1 (1 is critical). hp is 0 to 100. zClose = zombies within 10 tiles. zNear = within 30. zdx,zdy point at the nearest living zombie (+x East, +y South). bldgDir/bldgDist = nearest building ("HERE" or a small bldgDist means you are at one). foods/waters = edible food and clean water. weapon "none" means no melee weapon in hand. hour < 7 or hour >= 20 is night. err is set when your last action failed.

Actions, exactly one:
MOVE with dx and dy, each from -40 to 40. Commit to 15-40 tiles. Never inch 1-3.
LOOT when you are at a building and zClose is 0.
EAT when foods > 0 and hunger > 0.5. DRINK when waters > 0 and thirst > 0.5.
EQUIP when weapon is "none" and you have looted.
CLOSEDOOR when leaving a room and zombies are near.
CONCEAL to hide inside (doors and curtains).
BREAKIN to smash into a locked building.
STOP or WAIT only to hide.

Rules: if zDist is under 15, MOVE so dx*zdx + dy*zdy is negative. The body turns you around if you walk toward them. If bldgDir is HERE or bldgDist < 8 and zClose is 0, LOOT. BREAKIN only reaches a window within 8 tiles, CLOSEDOOR and CONCEAL within 2. If err is set, do not repeat that action. At night, be inside and CONCEAL.

JSON is the action, then one short thought. No other fields. Do not copy the sample numbers.
{"action":{"type":"MOVE","dx":16,"dy":0},"thought":"East, toward the building."}`;

export function extractJSON(raw) {
  let text = String(raw ?? '');
  text = text.replace(/<think>[\s\S]*?<\/think>/gi, '');
  const closed = text.toLowerCase().lastIndexOf('</think>');
  if (closed >= 0) text = text.slice(closed + '</think>'.length);
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start < 0 || end <= start) throw new Error('no JSON in reply');
  return JSON.parse(text.slice(start, end + 1));
}

function clip(value, max) {
  return String(value ?? '').replace(/[|\r\n]/g, ' ').trim().slice(0, max);
}

export function normalize(out) {
  const action = out && typeof out.action === 'object' && out.action ? out.action : {};
  let type = ACTIONS.includes(action.type) ? action.type : 'WAIT';
  let dx = Math.max(-40, Math.min(40, Math.round(Number(action.dx) || 0)));
  let dy = Math.max(-40, Math.min(40, Math.round(Number(action.dy) || 0)));
  if (type === 'MOVE') {
    const len = Math.hypot(dx, dy);
    if (len < 1) type = 'WAIT';
    else if (len < 8) {
      dx = Math.max(-40, Math.min(40, Math.round(dx / len * 16)));
      dy = Math.max(-40, Math.min(40, Math.round(dy / len * 16)));
    }
  }
  return {
    type,
    dx,
    dy,
    say: clip(out && out.say, 90),
    thought: clip(out && out.thought, 200),
    goal: clip(out && out.goal, 200),
    subtask: clip(out && out.subtask, 120),
    memory: clip(out && out.memory, 600),
    reply: clip(out && out.reply, 120),
  };
}

export function intentLine(seq, decision) {
  const goalField = clip(decision.subtask || decision.goal, 90);
  // The 8th field names what a verb acts on. Nothing fills it yet, and the mod reads a missing one as empty.
  const targetField = clip(decision.target, 90);
  return `${seq}|${decision.type}|${decision.dx}|${decision.dy}|${decision.say}|${decision.thought}|${goalField}|${targetField}`;
}

const BUILDING_STEP = {
  N: [0, -16], S: [0, 16], E: [16, 0], W: [-16, 0],
  NE: [16, -16], NW: [-16, -16], SE: [16, 16], SW: [-16, 16],
};

// zClose is the mod's count of living zombies at 10 tiles or nearer.
// An order after a slow thought replaces the flee and walks her back in.
export function zombieInside(percept) {
  if (!percept || percept.dead) return false;
  return (Number(percept.zClose) || 0) > 0;
}

// Clothes count as items. One failed equip must not be retried until the bag actually changes.
let failedEquipItems = '';
// One search per spot. If the bag did not change, the room has nothing new.
let lootedBag = null;
let lootedSpot = '';

function spotOf(percept) {
  const x = Number(percept.x);
  const y = Number(percept.y);
  if (!Number.isFinite(x) || !Number.isFinite(y)) return '';
  return `${Math.round(x / 8)},${Math.round(y / 8)}`;
}

function leaveHere(next, percept) {
  const away = {
    N: [0, 16], S: [0, -16], E: [-16, 0], W: [16, 0],
    NE: [-16, 16], NW: [16, 16], SE: [-16, -16], SW: [16, -16],
  };
  const step = away[String(percept.zDir || '')] || [0, -16];
  return {
    ...next, type: 'MOVE', dx: step[0], dy: step[1],
    goal: 'Find food in the next building.',
    subtask: 'Leave this building.',
    thought: 'Nothing new here. Moving on.',
  };
}

// The model will say "get to safety" and walk forever. A job with a finish replaces that
// when nothing is close enough to bite. The reflex still owns a zombie inside 10 tiles.
export function steerJob(decision, percept) {
  if (!percept || percept.dead) return decision;
  if ((Number(percept.zClose) || 0) > 0) return decision;
  const weapon = String(percept.weapon || 'none');
  const foods = Number(percept.foods) || 0;
  const waters = Number(percept.waters) || 0;
  const hunger = Number(percept.hunger) || 0;
  const thirst = Number(percept.thirst) || 0;
  const bldg = String(percept.bldgDir || 'none');
  const bldgDist = Number(percept.bldgDist);
  const atBuilding = bldg === 'HERE' || (Number.isFinite(bldgDist) && bldgDist >= 0 && bldgDist < 8);
  const next = { ...decision };
  const err = String(percept.err || '');
  const items = String(percept.items || '');
  if (weapon !== 'none') failedEquipItems = '';
  if (err.startsWith('equip')) failedEquipItems = items;
  // A new LOOT clears the queue, so a grab that is already running never finishes.
  if ((Number(percept.qlen) || 0) > 0) {
    return { ...next, type: 'WAIT', dx: 0, dy: 0, subtask: 'Finish this action.', thought: 'Still working.' };
  }
  // Only try the bag once. Worn clothes are always in the list, and they are not a weapon.
  if (weapon === 'none' && items && items !== failedEquipItems) {
    return { ...next, type: 'EQUIP', dx: 0, dy: 0, goal: 'Put a weapon in hand.', subtask: 'Equip.', thought: 'Weapon is in the bag. Equipping it.' };
  }

  if (foods > 0 && hunger > 0.55) {
    return { ...next, type: 'EAT', dx: 0, dy: 0, goal: 'Eat, then keep looting.', subtask: 'Eat.' };
  }
  if (waters > 0 && thirst > 0.55) {
    return { ...next, type: 'DRINK', dx: 0, dy: 0, goal: 'Drink, then keep looting.', subtask: 'Drink.' };
  }
  const spot = spotOf(percept);
  if (atBuilding && weapon === 'none' && lootedBag !== null && lootedSpot === spot && items === lootedBag) {
    return leaveHere(next, percept);
  }
  if (weapon === 'none' && bldg !== 'none' && !err.startsWith('loot')) {
    if (atBuilding) {
      lootedBag = items;
      lootedSpot = spot;
      return {
        ...next, type: 'LOOT', dx: 0, dy: 0,
        goal: 'Get a weapon and food from this building.',
        subtask: 'Loot this building.',
        thought: 'This building. Grabbing a weapon.',
      };
    }
    const step = BUILDING_STEP[bldg];
    if (step) {
      return {
        ...next, type: 'MOVE', dx: step[0], dy: step[1],
        goal: 'Get a weapon from the nearest building.',
        subtask: `Walk ${bldg} to the building.`,
        thought: `Building is ${bldg}. Going there.`,
      };
    }
  }
  // Standing still in a cleared room never becomes the next building. Step away from the zombies.
  const idle = decision.type === 'STOP' || decision.type === 'WAIT' || decision.type === 'CONCEAL';
  if (idle && weapon !== 'none') {
    const away = {
      N: [0, 16], S: [0, -16], E: [-16, 0], W: [16, 0],
      NE: [-16, 16], NW: [16, 16], SE: [-16, -16], SW: [16, -16],
    };
    const step = away[String(percept.zDir || '')] || [0, -16];
    return {
      ...next, type: 'MOVE', dx: step[0], dy: step[1],
      goal: 'Find food in the next building.',
      subtask: 'Leave this building.',
      thought: 'Nothing left here. Moving on.',
    };
  }
  return decision;
}

// The fields this prompt was written for. Percept v2 adds more (docs/percept.md), and they stay
// out of this prompt so it does not grow. The brain that uses them is a separate piece of work.
export const V1_FIELDS = [
  'dead', 'x', 'y', 'z', 'hour', 'day', 'outside', 'room', 'hp', 'hunger', 'thirst', 'fatigue',
  'endurance', 'panic', 'zTotal', 'zNear', 'zClose', 'zDist', 'zDir', 'zdx', 'zdy', 'foods',
  'waters', 'bldgDir', 'bldgDist', 'weapon', 'items', 'qlen', 'reflexed', 'lastSeq', 'err',
];

export function v1Senses(percept) {
  const out = {};
  if (!percept || typeof percept !== 'object') return out;
  for (const key of V1_FIELDS) if (key in percept) out[key] = percept[key];
  return out;
}

export function buildPrompt(state, percept, godLines) {
  const recent = (state.log || [])
    .filter((line) => line.kind === 'decide' || line.kind === 'god' || line.kind === 'death')
    .slice(-3)
    .map((line) => String(line.text).slice(0, 90))
    .join('\n') || '(none)';
  const voice = godLines && godLines.length
    ? `\nA voice only you can hear says: ${godLines.map((line) => `"${line}"`).join(' ')} Answer it in the thought, one short sentence.`
    : '';
  return `${PERSONA}

GOAL: ${state.goal || '(none)'}
SUBTASK: ${state.subtask || '(none)'}
RECENT:
${recent}${voice}
SENSES: ${JSON.stringify(v1Senses(percept))}`;
}
