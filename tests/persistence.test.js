// Build 4 regression tests: Privacy, Persistence, Onboarding
//
// Tests localStorage save/load, migration, welcome screen, and storage warnings.
//
// Run: node tests/persistence.test.js

const fs = require('fs');
const path = require('path');
const vm = require('vm');

const root = path.join(__dirname, '..');
const mockSchedule = JSON.parse(fs.readFileSync(path.join(root, 'docs/app/data/mock_schedule.json'), 'utf8'));
const demoSchedule = JSON.parse(fs.readFileSync(path.join(root, 'docs/app/data/demo_schedule.json'), 'utf8'));
const appSrc = fs.readFileSync(path.join(root, 'docs/app/app.js'), 'utf8')
  + '\n;Object.assign(globalThis, { ScheduleService, loadCommutes, saveCommutes, migratePersonalSamples, checkStorageAvailable, showToast, isDemoCommute, getCommutes: () => commutes, setCommutes: (a) => { commutes = a; }, PERSONAL_SAMPLE_IDS, COMMUTES_KEY, SEEDED_KEY, MIGRATION_KEY });';

// --- Test harness -----------------------------------------------------------
let pass = 0, fail = 0;
function check(name, cond, detail = '') {
  if (cond) { pass++; console.log(`  ✓ ${name}`); }
  else { fail++; console.log(`  ✗ ${name}${detail ? ' — ' + detail : ''}`); }
}

function createSandbox() {
  const storage = {};
  const toasts = [];
  const noop = () => {};
  const fakeEl = () => ({
    innerHTML: '', className: '', style: {}, classList: { add: noop, remove: noop, contains: () => false },
    addEventListener: noop, querySelectorAll: () => [], querySelector: () => null,
    appendChild: noop, insertBefore: noop, scrollIntoView: noop, setAttribute: noop,
    getAttribute: () => null, closest: () => null, textContent: ''
  });
  
  const sandbox = {
    console,
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
    TextDecoder: globalThis.TextDecoder,
    Buffer,
    fetch: async () => ({ ok: true, status: 200, json: async () => mockSchedule }),
    Date, Math, JSON, Array, Object,
    // Capture toasts
    _toasts: toasts,
    _showToastOrig: null
  };
  sandbox.window = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(appSrc, sandbox, { filename: 'app.js' });
  
  // Capture showToast calls
  sandbox._showToastOrig = sandbox.showToast;
  sandbox.showToast = (msg, type) => { toasts.push({ msg, type }); };
  
  return sandbox;
}

// ===========================================================================
//  Tests
// ===========================================================================

console.log('\n=== Build 4: Privacy & Persistence Tests ===\n');

console.log('Personal sample removal');
{
  check('mock_schedule.json has no morning_to_nyu sample',
    !mockSchedule.sampleCommutes.some(s => s.id === 'morning_to_nyu'));
  check('mock_schedule.json has no evening_home sample',
    !mockSchedule.sampleCommutes.some(s => s.id === 'evening_home'));
  check('mock_schedule.json keeps live_api_demo',
    mockSchedule.sampleCommutes.some(s => s.id === 'live_api_demo'));
  check('live_api_demo is marked as demo',
    mockSchedule.sampleCommutes.find(s => s.id === 'live_api_demo')?.demo === true);
}

console.log('\nMigration: convert personal samples to user commutes');
{
  const sb = createSandbox();
  sb.ScheduleService.init(mockSchedule);
  
  // Simulate existing user with old personal samples
  sb.localStorage.setItem('linkwise_commutes_v1', JSON.stringify([
    { id: 'morning_to_nyu', name: 'Morning to NYU', recurringDays: [1,2,3,4,5], legs: [] },
    { id: 'evening_home', name: 'Evening Home', recurringDays: [1,2,3,4,5], legs: [] },
    { id: 'cmt_xyz123', name: 'My Custom Commute', recurringDays: [1], legs: [] }
  ]));
  
  sb.loadCommutes();
  const commutes = sb.getCommutes();
  
  check('Migration converts morning_to_nyu to new ID',
    !commutes.some(c => c.id === 'morning_to_nyu'));
  check('Migration converts evening_home to new ID',
    !commutes.some(c => c.id === 'evening_home'));
  check('Migration preserves morning_to_nyu name',
    commutes.some(c => c.name === 'Morning to NYU' && c._migratedFromSample === true));
  check('Migration preserves evening_home name',
    commutes.some(c => c.name === 'Evening Home' && c._migratedFromSample === true));
  check('Migration preserves user-created commute unchanged',
    commutes.some(c => c.id === 'cmt_xyz123' && c.name === 'My Custom Commute'));
  check('Migration flag is set',
    sb.localStorage.getItem('linkwise_migrated_v2') === 'true');
  check('Total commutes after migration', commutes.length === 4); // 2 migrated + 1 custom + 1 demo
}

console.log('\nMigration: runs only once');
{
  const sb = createSandbox();
  sb.ScheduleService.init(mockSchedule);
  
  // Pre-set migration flag
  sb.localStorage.setItem('linkwise_migrated_v2', 'true');
  sb.localStorage.setItem('linkwise_commutes_v1', JSON.stringify([
    { id: 'morning_to_nyu', name: 'Old Sample', recurringDays: [], legs: [] }
  ]));
  
  sb.loadCommutes();
  const commutes = sb.getCommutes();
  
  check('Already-migrated flag prevents re-running migration',
    commutes.some(c => c.id === 'morning_to_nyu')); // ID unchanged
}

console.log('\nFirst-time visitor: empty localStorage');
{
  const sb = createSandbox();
  sb.ScheduleService.init(mockSchedule);
  sb.loadCommutes();
  
  const commutes = sb.getCommutes();
  const userCommutes = commutes.filter(c => !sb.isDemoCommute(c));
  
  check('First-time visitor has no user commutes', userCommutes.length === 0);
  check('Demo commute is seeded', commutes.some(c => c.id === 'live_api_demo'));
  check('Demo commute is marked as demo', sb.isDemoCommute(commutes.find(c => c.id === 'live_api_demo')));
}

console.log('\nSave confirmation feedback');
{
  const sb = createSandbox();
  sb.ScheduleService.init(mockSchedule);
  sb.setCommutes([{ id: 'cmt_test', name: 'Test', recurringDays: [1], legs: [] }]);
  
  sb.saveCommutes();
  
  check('Save triggers success toast', sb._toasts.some(t => t.type === 'success'));
  check('Success toast contains checkmark', sb._toasts.some(t => t.msg.includes('✓')));
}

console.log('\nStorage quota exceeded handling');
{
  const sb = createSandbox();
  sb.ScheduleService.init(mockSchedule);
  
  // Mock quota exceeded error
  sb.localStorage.setItem = () => {
    const err = new Error('QuotaExceededError');
    err.name = 'QuotaExceededError';
    throw err;
  };
  
  sb.setCommutes([{ id: 'cmt_test', name: 'Test', recurringDays: [1], legs: [] }]);
  sb.saveCommutes();
  
  check('Quota exceeded triggers error toast', sb._toasts.some(t => t.type === 'error'));
  check('Error message mentions storage full', sb._toasts.some(t => t.msg.toLowerCase().includes('storage full')));
}

console.log('\nStorage availability check');
{
  const sb = createSandbox();
  check('Storage available when working', sb.checkStorageAvailable() === true);
  
  const sb2 = createSandbox();
  sb2.localStorage.setItem = () => { throw new Error('Disabled'); };
  check('Storage unavailable when disabled', sb2.checkStorageAvailable() === false);
}

console.log('\nEdit commute persistence');
{
  const sb = createSandbox();
  sb.ScheduleService.init(mockSchedule);
  
  // Create initial commute
  sb.setCommutes([
    { id: 'cmt_edit_test', name: 'Original Name', recurringDays: [1], legs: [{ serviceId: 'test', preferredTime: 'next' }] }
  ]);
  sb.saveCommutes();
  
  // Clear toasts
  sb._toasts.length = 0;
  
  // Edit it
  const edited = sb.getCommutes();
  edited[0].name = 'Edited Name';
  edited[0].recurringDays = [1, 3, 5];
  sb.setCommutes(edited);
  sb.saveCommutes();
  
  // Reload
  const sb2 = createSandbox();
  sb2.ScheduleService.init(mockSchedule);
  sb2.localStorage.setItem('linkwise_commutes_v1', sb.localStorage.getItem('linkwise_commutes_v1'));
  sb2.localStorage.setItem('linkwise_seeded_samples_v1', sb.localStorage.getItem('linkwise_seeded_samples_v1'));
  sb2.localStorage.setItem('linkwise_migrated_v2', 'true'); // Skip migration
  sb2.loadCommutes();
  
  const reloaded = sb2.getCommutes().find(c => c.id === 'cmt_edit_test');
  check('Edited name persists after reload', reloaded?.name === 'Edited Name');
  check('Edited recurring days persist', JSON.stringify(reloaded?.recurringDays) === JSON.stringify([1,3,5]));
}

console.log('\nDelete commute persistence');
{
  const sb = createSandbox();
  sb.ScheduleService.init(mockSchedule);
  
  sb.setCommutes([
    { id: 'cmt_keep', name: 'Keep Me', recurringDays: [1], legs: [] },
    { id: 'cmt_delete', name: 'Delete Me', recurringDays: [1], legs: [] }
  ]);
  sb.saveCommutes();
  
  // Delete one
  sb.setCommutes(sb.getCommutes().filter(c => c.id !== 'cmt_delete'));
  sb.saveCommutes();
  
  // Reload
  const sb2 = createSandbox();
  sb2.ScheduleService.init(mockSchedule);
  sb2.localStorage.setItem('linkwise_commutes_v1', sb.localStorage.getItem('linkwise_commutes_v1'));
  sb2.localStorage.setItem('linkwise_seeded_samples_v1', sb.localStorage.getItem('linkwise_seeded_samples_v1'));
  sb2.localStorage.setItem('linkwise_migrated_v2', 'true');
  sb2.loadCommutes();
  
  const reloaded = sb2.getCommutes();
  check('Kept commute still present', reloaded.some(c => c.id === 'cmt_keep'));
  check('Deleted commute gone', !reloaded.some(c => c.id === 'cmt_delete'));
}

console.log('\nSample not re-seeded after deletion');
{
  const sb = createSandbox();
  sb.ScheduleService.init(mockSchedule);
  sb.loadCommutes();
  
  // Delete the demo
  sb.setCommutes(sb.getCommutes().filter(c => c.id !== 'live_api_demo'));
  sb.saveCommutes();
  
  const seeded = JSON.parse(sb.localStorage.getItem('linkwise_seeded_samples_v1') || '[]');
  check('Deleted sample is in seeded list', seeded.includes('live_api_demo'));
  
  // Reload
  const sb2 = createSandbox();
  sb2.ScheduleService.init(mockSchedule);
  sb2.localStorage.setItem('linkwise_commutes_v1', sb.localStorage.getItem('linkwise_commutes_v1'));
  sb2.localStorage.setItem('linkwise_seeded_samples_v1', sb.localStorage.getItem('linkwise_seeded_samples_v1'));
  sb2.localStorage.setItem('linkwise_migrated_v2', 'true');
  sb2.loadCommutes();
  
  check('Deleted sample not re-added on reload', !sb2.getCommutes().some(c => c.id === 'live_api_demo'));
}

console.log('\nDEMO schedule flagship remains DEMO-labeled');
{
  // Load with demo schedule (simulating no SCHEDULED data present)
  const sb = createSandbox();
  sb.ScheduleService.init(mockSchedule);
  sb.ScheduleService.addScheduledDoc(demoSchedule);
  
  const demoService = sb.ScheduleService.service('hblr_port_imperial_to_hblr_hoboken');
  check('DEMO service has dataBasis=demo', demoService?.dataBasis === 'demo');
  check('isDemo returns true for DEMO service', sb.ScheduleService.isDemo('hblr_port_imperial_to_hblr_hoboken'));
  check('isScheduled returns false for DEMO service', !sb.ScheduleService.isScheduled('hblr_port_imperial_to_hblr_hoboken'));
}

// ===========================================================================
//  Summary
// ===========================================================================

console.log(`\n${'='.repeat(60)}`);
console.log(`Total: ${pass + fail} tests | ${pass} passed | ${fail} failed`);
if (fail > 0) {
  console.log('\n❌ SOME TESTS FAILED');
  process.exit(1);
} else {
  console.log('\n✅ ALL TESTS PASSED');
}
