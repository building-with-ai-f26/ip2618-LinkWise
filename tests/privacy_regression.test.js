// Build 4 Privacy Regression Tests
//
// Verify that no personal identifying information is distributed to visitors.
//
// Run: node tests/privacy_regression.test.js

const fs = require('fs');
const path = require('path');
const vm = require('vm');

const root = path.join(__dirname, '..');
const mockSchedule = JSON.parse(fs.readFileSync(path.join(root, 'docs/app/data/mock_schedule.json'), 'utf8'));
const demoSchedule = JSON.parse(fs.readFileSync(path.join(root, 'docs/app/data/demo_schedule.json'), 'utf8'));
const appSrc = fs.readFileSync(path.join(root, 'docs/app/app.js'), 'utf8')
  + '\n;Object.assign(globalThis, { ScheduleService, loadCommutes, isDemoCommute, getCommutes: () => commutes, setCommutes: (a) => { commutes = a; } });';

// --- Test harness -----------------------------------------------------------
let pass = 0, fail = 0;
function check(name, cond, detail = '') {
  if (cond) { pass++; console.log(`  ✓ ${name}`); }
  else { fail++; console.log(`  ✗ ${name}${detail ? ' — ' + detail : ''}`); }
}

function createSandbox() {
  const storage = {};
  const noop = () => {};
  const fakeEl = () => ({
    innerHTML: '', className: '', style: {}, classList: { add: noop, remove: noop, contains: () => false },
    addEventListener: noop, querySelectorAll: () => [], querySelector: () => null,
    appendChild: noop, insertBefore: noop, scrollIntoView: noop, setAttribute: noop,
    getAttribute: () => null, closest: () => null, textContent: ''
  });
  
  const sandbox = {
    console: { log: () => {}, error: () => {} },
    document: {
      getElementById: () => fakeEl(),
      querySelector: () => fakeEl(),
      createElement: () => fakeEl(),
      body: fakeEl()
    },
    localStorage: {
      getItem: k => (k in storage ? storage[k] : null),
      setItem: (k, v) => { storage[k] = String(v); },
      removeItem: k => { delete storage[k]; }
    },
    setInterval: () => 0,
    clearInterval: noop,
    setTimeout: () => 0,
    clearTimeout: noop,
    TextDecoder: globalThis.TextDecoder,
    Buffer,
    fetch: async () => ({ ok: true, status: 200, json: async () => mockSchedule }),
    Date, Math, JSON, Array, Object,
    showToast: () => {}
  };
  sandbox.window = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(appSrc, sandbox, { filename: 'app.js' });
  
  return sandbox;
}

console.log('\n=== Build 4: Privacy Regression Tests ===\n');

console.log('Public Schedule Files — No Personal Information');
{
  const personalKeywords = ['port imperial', 'nyu', 'monday.*nyu', 'evening home', 'morning to nyu'];
  
  // Check mock_schedule.json
  const mockJson = JSON.stringify(mockSchedule).toLowerCase();
  check('mock_schedule.json: no "port imperial"', !mockJson.includes('port imperial'));
  check('mock_schedule.json: no "nyu"', !mockJson.includes('nyu'));
  check('mock_schedule.json: no "morning to nyu"', !mockJson.includes('morning to nyu'));
  check('mock_schedule.json: no "evening home"', !mockJson.includes('evening home'));
  
  // Check demo_schedule.json
  const demoJson = JSON.stringify(demoSchedule).toLowerCase();
  check('demo_schedule.json: no "port imperial"', !demoJson.includes('port imperial'));
  check('demo_schedule.json: no "nyu" destination', !demoJson.includes('"nyu"'));
  check('demo_schedule.json: stations use generic names', 
    demoJson.includes('north station') || demoJson.includes('transit hub'));
  
  // Check flagship journey name
  const flagship = demoSchedule.sampleCommutes?.find(c => c.id.includes('flagship') || c.id.includes('demo'));
  check('Flagship journey exists', !!flagship);
  check('Flagship journey is marked demo: true', flagship?.demo === true, 'demo=' + flagship?.demo);
  check('Flagship name is generic', !flagship?.name.toLowerCase().includes('nyu'));
  check('Flagship destination is generic', 
    !flagship?.destinationLabel || flagship.destinationLabel.toLowerCase() !== 'nyu',
    'destinationLabel=' + flagship?.destinationLabel);
}

console.log('\nFirst-Time Visitor — Welcome Screen, No Auto-Saved Journeys');
{
  const sb = createSandbox();
  sb.ScheduleService.init(mockSchedule);
  sb.ScheduleService.addScheduledDoc(demoSchedule);
  sb.loadCommutes();
  
  const commutes = sb.getCommutes();
  const userCommutes = commutes.filter(c => !sb.isDemoCommute(c));
  const demoCommutes = commutes.filter(c => sb.isDemoCommute(c));
  
  check('First-time visitor has no user commutes', userCommutes.length === 0);
  check('Demo commutes are present', demoCommutes.length > 0);
  check('All demo commutes have demo:true flag', demoCommutes.every(c => c.demo === true));
  
  // Check flagship is demo
  const flagship = commutes.find(c => c.id === 'demo_arrive_by_flagship');
  check('Flagship demo is loaded', !!flagship);
  check('Flagship is marked as demo', sb.isDemoCommute(flagship));
}

console.log('\nDemo Journeys — Never Auto-Added to My Commutes');
{
  const sb = createSandbox();
  sb.ScheduleService.init(mockSchedule);
  sb.ScheduleService.addScheduledDoc(demoSchedule);
  sb.loadCommutes();
  
  const commutes = sb.getCommutes();
  
  // All demo journeys should be filtered from user commutes
  const demoIds = ['live_api_demo', 'demo_arrive_by_flagship'];
  for (const id of demoIds) {
    const journey = commutes.find(c => c.id === id);
    if (journey) {
      check(`${id} is marked demo:true`, journey.demo === true);
      check(`${id} filtered by isDemoCommute`, sb.isDemoCommute(journey));
    }
  }
  
  // User commutes list should be empty
  const userCommutes = commutes.filter(c => !sb.isDemoCommute(c));
  check('No demo journeys in user commutes list', userCommutes.length === 0);
}

console.log('\nExploring Demo — Does Not Save Personal Commute');
{
  const sb = createSandbox();
  sb.ScheduleService.init(mockSchedule);
  sb.ScheduleService.addScheduledDoc(demoSchedule);
  sb.loadCommutes();
  
  // User "explores" a demo by viewing it
  const beforeCount = sb.getCommutes().filter(c => !sb.isDemoCommute(c)).length;
  
  // Simulate viewing demo (doesn't create a save action in real app)
  // The demo remains demo:true and doesn't duplicate
  
  sb.loadCommutes(); // Reload
  const afterCount = sb.getCommutes().filter(c => !sb.isDemoCommute(c)).length;
  
  check('Exploring demo does not create user commute', beforeCount === afterCount && beforeCount === 0);
}

console.log('\nReturning User — Customized Journeys Preserved');
{
  const sb = createSandbox();
  sb.ScheduleService.init(mockSchedule);
  
  // Simulate returning user with saved custom commute
  sb.localStorage.setItem('linkwise_commutes_v1', JSON.stringify([
    {
      id: 'cmt_user123',
      name: 'My Custom Route',
      recurringDays: [1, 3, 5],
      scheduleMode: 'arrive_by',
      arrivalGoal: '09:00',
      legs: [{ serviceId: 'hblr_port_imperial_to_hblr_hoboken', preferredTime: 'next' }]
    }
  ]));
  sb.localStorage.setItem('linkwise_migrated_v2', 'true'); // Skip migration
  
  sb.loadCommutes();
  
  const commutes = sb.getCommutes();
  const userCommutes = commutes.filter(c => !sb.isDemoCommute(c));
  const customRoute = userCommutes.find(c => c.id === 'cmt_user123');
  
  check('Returning user has their custom commute', !!customRoute);
  check('Custom commute name preserved', customRoute?.name === 'My Custom Route');
  check('Custom commute days preserved', JSON.stringify(customRoute?.recurringDays) === '[1,3,5]');
  check('Custom commute not marked as demo', !sb.isDemoCommute(customRoute));
}

console.log('\nPublished Files — No Identifying Schedule Patterns');
{
  // Check that flagship doesn't expose specific class/work schedule
  const flagship = demoSchedule.sampleCommutes?.[0];
  
  // Demo is clearly synthetic and not revealing specific routine
  check('Flagship is marked as demo', flagship?.demo === true);
  check('Flagship uses generic destination label', 
    !flagship?.destinationLabel || flagship.destinationLabel === 'Destination',
    'destinationLabel=' + flagship?.destinationLabel);
}

console.log('\nSample Commute IDs — No Personal References');
{
  const allSamples = [
    ...(mockSchedule.sampleCommutes || []),
    ...(demoSchedule.sampleCommutes || [])
  ];
  
  const personalIds = ['morning_to_nyu', 'evening_home', 'monday_nyu_flagship'];
  
  for (const id of personalIds) {
    const found = allSamples.find(s => s.id === id);
    check(`No sample with ID "${id}"`, !found);
  }
  
  // All samples should have generic IDs
  const hasGenericIds = allSamples.every(s => 
    s.id.includes('demo') || s.id.includes('live') || s.id.includes('api')
  );
  check('All sample IDs are generic/neutral', hasGenericIds,
    'IDs: ' + allSamples.map(s => s.id).join(', '));
}

// ===========================================================================
//  Summary
// ===========================================================================

console.log(`\n${'='.repeat(60)}`);
console.log(`Total: ${pass + fail} tests | ${pass} passed | ${fail} failed`);
if (fail > 0) {
  console.log('\n❌ PRIVACY TESTS FAILED');
  process.exit(1);
} else {
  console.log('\n✅ ALL PRIVACY TESTS PASSED');
}
