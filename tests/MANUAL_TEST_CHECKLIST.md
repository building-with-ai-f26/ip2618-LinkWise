# Build 4 Manual Testing Checklist

## Privacy & Onboarding Tests

### Test 1: First-Time Visitor (Fresh Browser)
**Setup:** Clear localStorage or use incognito mode

1. Open app URL
2. **Expected:** See welcome screen with:
   - "Welcome to LinkWise" headline
   - "Your personal commuter assistant" tagline
   - "Create my commute" primary button
   - "Try a demo journey" secondary button
   - Device-local storage notice
3. **Expected:** Countdown area shows "Create your first commute to see live departure countdowns"
4. Click "Create my commute"
5. **Expected:** Onboarding sheet opens
6. Create a test commute, save
7. **Expected:** Toast notification "✓ Saved"
8. **Expected:** Dashboard shows "My Commutes" button, featured journey name
9. **Expected:** Countdown shows the created journey

### Test 2: Returning Visitor
**Setup:** Complete Test 1 first

1. Refresh the page
2. **Expected:** Dashboard shows immediately (no welcome screen)
3. **Expected:** Previously created commute is still visible
4. **Expected:** Featured journey matches your saved commute

### Test 3: Personal Samples Migration
**Setup:** Manually inject old samples into localStorage before opening app

```javascript
localStorage.setItem('linkwise_commutes_v1', JSON.stringify([
  { id: 'morning_to_nyu', name: 'Morning to NYU', recurringDays: [1,2,3,4,5], legs: [{serviceId: 'hblr_port_imperial_to_hoboken', preferredTime: '07:56'}] },
  { id: 'evening_home', name: 'Evening Home', recurringDays: [1,2,3,4,5], legs: [{serviceId: 'path_9th_to_hoboken', preferredTime: '17:12'}] }
]));
```

1. Open app
2. **Expected:** Old samples are converted to user commutes with new IDs
3. Open "My Commutes" drawer
4. **Expected:** See "Morning to NYU" and "Evening Home" (kept as user commutes)
5. Check localStorage: `localStorage.getItem('linkwise_migrated_v2')`
6. **Expected:** Migration flag is set to 'true'
7. Refresh page
8. **Expected:** No duplicate commutes created

### Test 4: Edit Commute Persistence
**Setup:** Have at least one saved commute

1. Open "My Commutes" drawer
2. Click "Edit" on a commute
3. Change name from "X" to "Y"
4. Change recurring days (e.g., add Wednesday)
5. Click "Save commute"
6. **Expected:** Toast "✓ Saved"
7. Close app completely
8. Reopen app
9. **Expected:** Edited name "Y" is shown
10. Click edit again
11. **Expected:** Wednesday is selected in recurring days

### Test 5: Delete Commute Persistence
**Setup:** Have at least two saved commutes

1. Open "My Commutes" drawer
2. Click "Delete" on a commute
3. Confirm deletion
4. **Expected:** Toast "✓ Saved"
5. **Expected:** Commute removed from list
6. Refresh page
7. **Expected:** Deleted commute does NOT reappear

### Test 6: Demo Journey Exploration
**Setup:** Fresh or existing state

1. Click "My Commutes" or welcome screen "Try a demo journey"
2. Click "Explore" button
3. **Expected:** Drawer shows "Explore · Demos" title
4. **Expected:** See "Explore Live Trains (MTA Demo)" with LIVE badge
5. Click on demo journey
6. **Expected:** Countdown loads MTA live data
7. **Expected:** Status shows "LIVE" badge
8. Open "My Commutes" again
9. **Expected:** Demo journey does NOT appear in user commutes list

## Persistence & Error Handling Tests

### Test 7: Save Confirmation Feedback
**Setup:** Any state

1. Create or edit a commute
2. Click "Save commute"
3. **Expected:** Toast notification appears at bottom-center
4. **Expected:** Toast shows "✓ Saved" in green
5. **Expected:** Toast disappears after ~3 seconds

### Test 8: Private Browsing Warning
**Setup:** Open in private/incognito mode

1. Open app
2. **Expected:** Red warning banner at top: "⚠️ Private browsing detected..."
3. Try to create a commute
4. Save it
5. **Expected:** Toast "⚠ Could not save (check private browsing mode)" in red
6. Refresh page
7. **Expected:** Commute is gone (not saved)
8. **Expected:** Warning banner still present

### Test 9: Storage Quota Error Handling
**Setup:** Browser console

```javascript
// Simulate quota exceeded
const originalSetItem = localStorage.setItem;
localStorage.setItem = function() {
  const err = new Error('QuotaExceededError');
  err.name = 'QuotaExceededError';
  throw err;
};
```

1. Try to save a commute
2. **Expected:** Toast "⚠ Storage full — delete old commutes to free space" in red
3. **Expected:** Console error logged

### Test 10: Sample Not Re-Seeded After Deletion
**Setup:** Have the demo commute seeded

1. Open "Explore" drawer
2. Note that "Explore Live Trains" demo exists
3. Open browser console, run: 
   ```javascript
   commutes = commutes.filter(c => c.id !== 'live_api_demo');
   saveCommutes();
   ```
4. Refresh page
5. **Expected:** Demo does NOT reappear in "My Commutes"
6. **Expected:** Still appears in "Explore" drawer (not user-owned)

## Mobile & Responsive Tests

### Test 11: Mobile Welcome Screen
**Setup:** Mobile device or mobile emulation, fresh browser

1. Open app
2. **Expected:** Welcome screen is readable and buttons are tappable
3. **Expected:** "Create my commute" button fills width
4. **Expected:** Device-local notice is readable
5. Tap "Create my commute"
6. **Expected:** Sheet slides up from bottom
7. Create commute
8. **Expected:** Buttons are large enough for touch

### Test 12: Toast on Mobile
**Setup:** Mobile device

1. Save a commute
2. **Expected:** Toast appears centered at bottom
3. **Expected:** Toast is readable and doesn't overflow
4. **Expected:** Toast doesn't block important UI

## PostHog Privacy Tests

### Test 13: Session Replay Masking
**Setup:** PostHog session replay enabled

1. Create a commute named "My Secret Route"
2. Set destination station
3. Open "My Commutes" drawer
4. Check PostHog session recording (requires PostHog access)
5. **Expected:** Commute name "My Secret Route" is masked (shows **** or similar)
6. **Expected:** Station names in .cmx-route are masked
7. **Expected:** Featured journey name is masked

### Test 14: Opt-Out Still Works
**Setup:** Fresh browser

1. See PostHog privacy notice
2. Click "Decline recording"
3. **Expected:** Notice disappears
4. Create commutes, navigate around
5. **Expected:** No session recording in PostHog (requires PostHog access)

## Data Integrity Tests

### Test 15: No Personal Data in Public Files
**Setup:** Check source files

1. View `docs/app/data/mock_schedule.json`
2. **Expected:** `sampleCommutes` array has only `live_api_demo`
3. **Expected:** NO `morning_to_nyu` or `evening_home`
4. View `docs/app/data/demo_schedule.json`
5. **Expected:** Only generic "Monday → NYU" (clearly marked DEMO)

### Test 16: DEMO Data Labeling
**Setup:** Have DEMO schedule loaded (no local SCHEDULED files)

1. Open app
2. Create commute using HBLR Port Imperial → Hoboken leg
3. View countdown
4. **Expected:** Status badge shows "DEMO" (not SCHEDULED or LIVE)
5. **Expected:** Disclaimer mentions "simulated, not real/live"
6. **Expected:** Service shown as "DEMO" in journey panel

## Edge Cases

### Test 17: Empty Commute Name
**Setup:** Create commute

1. Leave name field blank
2. Click "Save commute"
3. **Expected:** Name defaults to "My commute"
4. **Expected:** Saves successfully

### Test 18: Cross-Browser Persistence
**Setup:** Chrome, then Safari/Firefox

1. In Chrome: Create commute "Chrome Journey"
2. Save, verify it appears
3. Open same URL in Safari
4. **Expected:** "Chrome Journey" does NOT appear (device-local)
5. **Expected:** Welcome screen shown (new browser = new storage)

### Test 19: Multiple Tabs
**Setup:** Two tabs, same browser

1. Tab 1: Create and save commute "Tab 1 Journey"
2. Tab 2: Refresh
3. **Expected:** "Tab 1 Journey" appears (localStorage shared)
4. Tab 2: Edit "Tab 1 Journey" to "Tab 2 Edit"
5. Tab 1: Refresh
6. **Expected:** See "Tab 2 Edit" (last write wins)

## Regression: Existing Features Still Work

### Test 20: Arrive-By Planning (DEMO Mode)
**Setup:** DEMO data loaded

1. Create commute with arrive-by mode
2. Set arrival goal 10:30 AM
3. **Expected:** Journey plans backward from goal
4. **Expected:** Shows departure time, transfer windows, arrival buffer

### Test 21: Fixed Departure Mode
**Setup:** Any data

1. Create commute with fixed mode
2. Select specific departure time
3. Save
4. **Expected:** Countdown shows selected time
5. **Expected:** Rolls to next occurrence on that day

### Test 22: MTA Live Demo
**Setup:** Network access

1. Open "Explore" → "Explore Live Trains (MTA Demo)"
2. **Expected:** Loads real MTA GTFS-Realtime feed
3. **Expected:** Shows LIVE badge
4. **Expected:** Departures update when new data arrives
5. **Expected:** "LIVE" status (not MOCK/SCHEDULED)

---

## Pass Criteria

**All tests must pass before deployment:**
- [ ] All automated tests pass (`node tests/persistence.test.js`, `node tests/schedule_logic.test.js`, `node tests/build_schedules.test.mjs`)
- [ ] Welcome screen shows for first-time visitors
- [ ] Personal samples removed from public files
- [ ] Migration preserves existing user data
- [ ] Edit/delete persistence works across page reloads
- [ ] Save confirmation toasts appear
- [ ] Storage errors are handled gracefully
- [ ] Private browsing shows warning
- [ ] PostHog masking still protects PII
- [ ] Demo journeys remain clearly labeled
- [ ] Mobile UI is usable
- [ ] No new console errors

---

**Tester:** _________________  
**Date:** _________________  
**Browser/Device:** _________________  
**Result:** ☐ PASS  ☐ FAIL  
**Notes:** _________________
