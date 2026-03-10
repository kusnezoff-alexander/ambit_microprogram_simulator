#!/usr/bin/env node
/**
 * Headless visual testing for PIM Microprogram Visualizer.
 * Uses Puppeteer to load the page in a real browser engine and verify:
 *   1. Page loads without JS errors
 *   2. Both backend tabs render and switch correctly
 *   3. Ambit backend: programs load, step/run/reset work, output is correct
 *   4. ReRAM backend: programs load, horizontal renderer works, init collapsible, output correct
 */

import puppeteer from 'puppeteer';

const URL = 'http://localhost:8000/visualize_program.html';

let browser, page;
const errors = [];
const warnings = [];
let testsPassed = 0;
let testsFailed = 0;

function assert(condition, message) {
    if (condition) {
        testsPassed++;
        console.log(`  ✓ ${message}`);
    } else {
        testsFailed++;
        console.log(`  ✗ FAIL: ${message}`);
        errors.push(message);
    }
}

async function setup() {
    browser = await puppeteer.launch({
        headless: true,
        args: ['--no-sandbox', '--disable-setuid-sandbox'],
        executablePath: '/usr/bin/chromium-browser'
    });
    page = await browser.newPage();

    // Collect JS execution errors (pageerror) separately from network/resource errors
    const jsErrors = [];
    const networkErrors = [];
    page.on('console', msg => {
        if (msg.type() === 'error') {
            const text = msg.text();
            // Network resource errors (404s etc) are noisy and expected for favicon
            if (text.includes('Failed to load resource')) {
                networkErrors.push(text);
                return;
            }
            jsErrors.push(text);
        }
    });
    page.on('pageerror', err => {
        jsErrors.push(err.message);
    });
    // Track actual request failures to detect missing program files
    page.on('response', resp => {
        if (resp.status() >= 400) {
            const url = resp.url();
            // Only flag non-favicon 404s for JS/JSON resources
            if (!url.includes('favicon') && (url.endsWith('.js') || url.endsWith('.json') || url.endsWith('.txt'))) {
                jsErrors.push(`HTTP ${resp.status()} for ${url}`);
            }
        }
    });

    // Store for later inspection
    page._jsErrors = jsErrors;

    await page.goto(URL, { waitUntil: 'networkidle0', timeout: 15000 });
}

async function teardown() {
    if (browser) await browser.close();
}

// Wait for programs to load (async fetch)
async function waitForPrograms(timeout = 10000) {
    await page.waitForFunction(() => {
        const select = document.getElementById('program');
        return select && select.options.length > 1;
    }, { timeout });
}

// ============================================================
// Test 1: Page loads without errors
// ============================================================
async function testPageLoad() {
    console.log('\n=== Test: Page Load ===');

    const title = await page.title();
    assert(title === 'PIM Visualizer', `Page title is "${title}"`);

    // Check no JS errors on load
    const jsErrors = page._jsErrors;
    assert(jsErrors.length === 0, `No JS errors on load (got ${jsErrors.length}: ${jsErrors.join('; ')})`);

    // Check tab bar exists
    const tabCount = await page.$$eval('.tab-btn', tabs => tabs.length);
    assert(tabCount === 2, `Tab bar has 2 tabs (got ${tabCount})`);

    // Check tab labels
    const tabLabels = await page.$$eval('.tab-btn', tabs => tabs.map(t => t.textContent));
    assert(tabLabels.includes('Ambit'), `Has Ambit tab`);
    assert(tabLabels.includes('ReRAM'), `Has ReRAM tab`);

    // First tab should be active
    const activeTab = await page.$eval('.tab-btn.active', t => t.textContent);
    assert(activeTab === 'Ambit', `Ambit tab is active by default (got "${activeTab}")`);
}

// ============================================================
// Test 2: Ambit backend
// ============================================================
async function testAmbitBackend() {
    console.log('\n=== Test: Ambit Backend ===');

    // Switch to Ambit (should already be active, but be explicit)
    await page.click('#tab-Ambit');
    await waitForPrograms();

    // Check programs loaded
    const progCount = await page.$eval('#program', sel => sel.options.length - 1);
    assert(progCount > 0, `Ambit programs loaded: ${progCount}`);

    // Check memory label
    const memLabel = await page.$eval('#memoryLabel', el => el.textContent);
    assert(memLabel.includes('DRAM') || memLabel.includes('Vertical'), `Memory label mentions DRAM/Vertical: "${memLabel}"`);

    // Check timing inputs exist for AAP and AP
    const hasAAP = await page.$('#timing-AAP') !== null;
    const hasAP = await page.$('#timing-AP') !== null;
    assert(hasAAP, 'Has AAP timing input');
    assert(hasAP, 'Has AP timing input');

    // Select abs4 program
    const abs4Exists = await page.$eval('#program', sel => {
        for (const opt of sel.options) {
            if (opt.value === 'abs4') return true;
        }
        return false;
    });

    if (!abs4Exists) {
        console.log('  ⚠ abs4 not found, skipping Ambit execution tests');
        return;
    }

    // Load abs4 with input 5
    await page.select('#program', 'abs4');
    await page.evaluate(() => { document.getElementById('inputVal').value = '5'; });
    await page.click('#loadBtn');
    await page.waitForSelector('#main[style*="block"]', { timeout: 3000 });

    // Check main area is visible
    const mainVisible = await page.$eval('#main', el => el.style.display !== 'none');
    assert(mainVisible, 'Main panel visible after loading abs4');

    // Check instructions rendered
    const instrCount = await page.$$eval('.instr', items => items.length);
    assert(instrCount > 0, `Instructions rendered: ${instrCount}`);

    // Check counter shows 0 / N
    const counter = await page.$eval('#counter', el => el.textContent.trim());
    assert(counter.startsWith('0 /'), `Counter starts at 0: "${counter}"`);

    // Step once
    await page.click('#stepBtn');
    const counterAfterStep = await page.$eval('#counter', el => el.textContent.trim());
    assert(counterAfterStep.startsWith('1 /'), `Counter after step: "${counterAfterStep}"`);

    // Run all
    await page.click('#runBtn');
    const counterAfterRun = await page.$eval('#counter', el => el.textContent.trim());
    const parts = counterAfterRun.split('/').map(s => s.trim());
    assert(parts[0] === parts[1], `Counter shows complete: "${counterAfterRun}"`);

    // Check result section
    const resultText = await page.$eval('#result', el => el.textContent);
    assert(resultText.includes('5'), `Result mentions input 5: "${resultText.substring(0, 100)}"`);
    assert(resultText.includes('CORRECT') || resultText.includes('Expected'), `Result has expected/correct: "${resultText.substring(0, 150)}"`);

    // Test abs4 with negative value (e.g. 13 = -3 in 4-bit signed)
    await page.evaluate(() => { document.getElementById('inputVal').value = '13'; });
    await page.click('#loadBtn');
    await page.click('#runBtn');
    const resultNeg = await page.$eval('#result', el => el.textContent);
    assert(resultNeg.includes('CORRECT'), `abs4(13=-3) is CORRECT: "${resultNeg.substring(0, 150)}"`);

    // Reset
    await page.click('#resetBtn');
    const counterAfterReset = await page.$eval('#counter', el => el.textContent.trim());
    assert(counterAfterReset.startsWith('0 /'), `Counter reset to 0: "${counterAfterReset}"`);

    // Test stats panel
    const statsText = await page.$eval('#stats', el => el.textContent);
    assert(statsText.includes('AAP'), `Stats mention AAP: "${statsText.substring(0, 100)}"`);
    assert(statsText.includes('AP'), `Stats mention AP: "${statsText.substring(0, 100)}"`);
    assert(statsText.includes('latency'), `Stats mention latency: "${statsText.substring(0, 100)}"`);

    // Check no new JS errors
    assert(page._jsErrors.length === 0, `No JS errors during Ambit tests (got ${page._jsErrors.length})`);
}

// ============================================================
// Test 3: ReRAM backend
// ============================================================
async function testReRAMBackend() {
    console.log('\n=== Test: ReRAM Backend ===');

    // Switch to ReRAM tab
    await page.click('#tab-ReRAM');
    await new Promise(r => setTimeout(r, 500));
    await waitForPrograms();

    // Check active tab
    const activeTab = await page.$eval('.tab-btn.active', t => t.textContent);
    assert(activeTab === 'ReRAM', `ReRAM tab is active: "${activeTab}"`);

    // Check programs loaded
    const progCount = await page.$eval('#program', sel => sel.options.length - 1);
    assert(progCount > 0, `ReRAM programs loaded: ${progCount}`);
    console.log(`    (${progCount} programs found)`);

    // Check memory label
    const memLabel = await page.$eval('#memoryLabel', el => el.textContent);
    assert(memLabel.includes('Crossbar') || memLabel.includes('Horizontal'), `Memory label: "${memLabel}"`);

    // Check timing inputs for ReRAM
    const hasNor2 = await page.$('#timing-nor2') !== null;
    const hasInv1 = await page.$('#timing-inv1') !== null;
    const hasInit = await page.$('#timing-init') !== null;
    assert(hasNor2, 'Has nor2 timing input');
    assert(hasInv1, 'Has inv1 timing input');
    assert(hasInit, 'Has init timing input');

    // No JS errors after tab switch
    assert(page._jsErrors.length === 0, `No JS errors after ReRAM switch (got ${page._jsErrors.length}: ${page._jsErrors.join('; ')})`);
}

// ============================================================
// Test 4: ReRAM abs program execution
// ============================================================
async function testReRAMAbs() {
    console.log('\n=== Test: ReRAM abs_8bit ===');

    // Make sure ReRAM is active
    const activeTab = await page.$eval('.tab-btn.active', t => t.textContent);
    if (activeTab !== 'ReRAM') {
        await page.click('#tab-ReRAM');
        await new Promise(r => setTimeout(r, 500));
        await waitForPrograms();
    }

    // Select abs program
    const absName = await page.evaluate(() => {
        const sel = document.getElementById('program');
        for (const opt of sel.options) {
            if (opt.value.includes('abs')) return opt.value;
        }
        return null;
    });
    assert(absName !== null, `Found abs program: ${absName}`);
    if (!absName) return;

    await page.select('#program', absName);

    // Set multi-lane input: abs([5, 251, 42])
    await page.evaluate(() => { document.getElementById('inputVal').value = '[5, 251, 42]'; });
    await page.click('#loadBtn');
    await page.waitForSelector('#main[style*="block"]', { timeout: 3000 });

    // Check horizontal table rendered
    const hasTable = await page.$('#memory table') !== null;
    assert(hasTable, 'Horizontal memory table rendered');

    // Check multiple lanes (rows) created
    const laneCount = await page.evaluate(() => {
        const tbl = document.querySelector('#memory table');
        const rows = tbl ? tbl.querySelectorAll('tr') : [];
        // Subtract 1 for header row
        return rows.length - 1;
    });
    assert(laneCount === 3, `3 SIMD lanes created for 3-element input (got ${laneCount})`);

    // Check we have a scrollable container
    const hasOverflow = await page.evaluate(() => {
        const wrapper = document.querySelector('#memory div[style*="overflow-x"]');
        return wrapper !== null;
    });
    assert(hasOverflow, 'Scrollable container with overflow-x exists');

    // Check sticky row label
    const hasStickyLabel = await page.evaluate(() => {
        const stickyCells = document.querySelectorAll('#memory td[style*="sticky"], #memory th[style*="sticky"]');
        return stickyCells.length > 0;
    });
    assert(hasStickyLabel, 'Sticky row labels present');

    // Check instructions include init
    const hasInitInstr = await page.evaluate(() => {
        const instrs = document.querySelectorAll('.instr');
        for (const el of instrs) {
            if (el.textContent.includes('INIT')) return true;
        }
        return false;
    });
    assert(hasInitInstr, 'Init instructions visible');

    // Check collapsible init: look for init-summary class
    const hasCollapsibleInit = await page.evaluate(() => {
        return document.querySelectorAll('.init-summary').length > 0;
    });
    assert(hasCollapsibleInit, 'Collapsible init summaries present');

    // Click to expand first init
    const expanded = await page.evaluate(() => {
        const summary = document.querySelector('.init-summary');
        if (!summary) return false;
        summary.click();
        // Check if detail is now visible
        const detail = summary.nextElementSibling;
        return detail && detail.style.display !== 'none';
    });
    assert(expanded, 'Init instruction expands on click');

    // Run all
    await page.click('#runBtn');

    // Check result for abs([5, 251, 42]) = [5, 5, 42]
    const resultText = await page.$eval('#result', el => el.textContent);
    assert(resultText.includes('CORRECT'), `abs([5,251,42])=[5,5,42] CORRECT: "${resultText.substring(0, 150)}"`);

    // Check stats
    const statsText = await page.$eval('#stats', el => el.textContent);
    assert(statsText.includes('NOR2'), `Stats mention NOR2`);
    assert(statsText.includes('INV1'), `Stats mention INV1`);
    assert(statsText.includes('INIT'), `Stats mention INIT`);
    assert(statsText.includes('latency'), `Stats mention latency`);

    // No JS errors
    assert(page._jsErrors.length === 0, `No JS errors during ReRAM abs tests (${page._jsErrors.length})`);
}

// ============================================================
// Test 5: ReRAM adder (binary operation)
// ============================================================
async function testReRAMAdder() {
    console.log('\n=== Test: ReRAM adder_8bit ===');

    const activeTab = await page.$eval('.tab-btn.active', t => t.textContent);
    if (activeTab !== 'ReRAM') {
        await page.click('#tab-ReRAM');
        await new Promise(r => setTimeout(r, 500));
        await waitForPrograms();
    }

    const adderName = await page.evaluate(() => {
        const sel = document.getElementById('program');
        for (const opt of sel.options) {
            if (opt.value.includes('adder')) return opt.value;
        }
        return null;
    });
    assert(adderName !== null, `Found adder program: ${adderName}`);
    if (!adderName) return;

    await page.select('#program', adderName);

    // Generate random should produce nested array for binary op
    await page.click('#randomBtn');
    const inputVal = await page.$eval('#inputVal', el => el.value);
    assert(inputVal.startsWith('[['), `Random generates nested array for binary op: "${inputVal.substring(0, 40)}"`);

    // Test 3 + 5 = 8 (multi-lane)
    await page.evaluate(() => { document.getElementById('inputVal').value = '[[3,10],[5,2]]'; });
    await page.click('#loadBtn');
    await page.click('#runBtn');

    const resultText = await page.$eval('#result', el => el.textContent);
    assert(resultText.includes('CORRECT'), `add([[3,10],[5,2]]) = [8,12] CORRECT: "${resultText.substring(0, 150)}"`);

    // Test adder with overflow: 247 + 28 = 19 (8-bit wrap)
    await page.evaluate(() => { document.getElementById('inputVal').value = '[[247],[28]]'; });
    await page.click('#loadBtn');
    await page.click('#runBtn');
    const overflowResult = await page.$eval('#result', el => el.textContent);
    assert(overflowResult.includes('CORRECT'), `add(247,28)=19 (overflow) CORRECT: "${overflowResult.substring(0, 150)}"`);

    // No JS errors
    assert(page._jsErrors.length === 0, `No JS errors during adder test (${page._jsErrors.length}: ${page._jsErrors.join('; ')})`);
}

// ============================================================
// Test 6: ReRAM popcount
// ============================================================
async function testReRAMPopcount() {
    console.log('\n=== Test: ReRAM popcount_8bit ===');

    const activeTab = await page.$eval('.tab-btn.active', t => t.textContent);
    if (activeTab !== 'ReRAM') {
        await page.click('#tab-ReRAM');
        await new Promise(r => setTimeout(r, 500));
        await waitForPrograms();
    }

    const pcntName = await page.evaluate(() => {
        const sel = document.getElementById('program');
        for (const opt of sel.options) {
            if (opt.value.includes('popcount')) return opt.value;
        }
        return null;
    });
    assert(pcntName !== null, `Found popcount program: ${pcntName}`);
    if (!pcntName) return;

    await page.select('#program', pcntName);
    // popcount multi-lane: [179, 255, 0] = [5, 8, 0]
    await page.evaluate(() => { document.getElementById('inputVal').value = '[179, 255, 0]'; });
    await page.click('#loadBtn');
    await page.click('#runBtn');

    const resultText = await page.$eval('#result', el => el.textContent);
    assert(resultText.includes('CORRECT'), `popcount([179,255,0])=[5,8,0] CORRECT: "${resultText.substring(0, 150)}"`);
}

// ============================================================
// Test 7: ReRAM subtractor
// ============================================================
async function testReRAMSubtractor() {
    console.log('\n=== Test: ReRAM subtractor_8bit ===');

    const activeTab = await page.$eval('.tab-btn.active', t => t.textContent);
    if (activeTab !== 'ReRAM') {
        await page.click('#tab-ReRAM');
        await new Promise(r => setTimeout(r, 500));
        await waitForPrograms();
    }

    const subName = await page.evaluate(() => {
        const sel = document.getElementById('program');
        for (const opt of sel.options) {
            if (opt.value.includes('subtractor')) return opt.value;
        }
        return null;
    });
    assert(subName !== null, `Found subtractor program: ${subName}`);
    if (!subName) return;

    await page.select('#program', subName);
    // 10 - 3 = 7, 3 - 5 = -2
    await page.evaluate(() => { document.getElementById('inputVal').value = '[[10,3],[3,5]]'; });
    await page.click('#loadBtn');
    await page.click('#runBtn');

    const resultText = await page.$eval('#result', el => el.textContent);
    assert(resultText.includes('CORRECT'), `sub([[10,3],[3,5]])=[7,-2] CORRECT: "${resultText.substring(0, 150)}"`);
}

// ============================================================
// Test 8: ReRAM multiplier
// ============================================================
async function testReRAMMultiplier() {
    console.log('\n=== Test: ReRAM multiplier_4bit ===');

    const activeTab = await page.$eval('.tab-btn.active', t => t.textContent);
    if (activeTab !== 'ReRAM') {
        await page.click('#tab-ReRAM');
        await new Promise(r => setTimeout(r, 500));
        await waitForPrograms();
    }

    const mulName = await page.evaluate(() => {
        const sel = document.getElementById('program');
        for (const opt of sel.options) {
            if (opt.value.includes('multiplier')) return opt.value;
        }
        return null;
    });
    assert(mulName !== null, `Found multiplier program: ${mulName}`);
    if (!mulName) return;

    await page.select('#program', mulName);
    // 3 * 5 = 15, 2 * 7 = 14
    await page.evaluate(() => { document.getElementById('inputVal').value = '[[3,2],[5,7]]'; });
    await page.click('#loadBtn');
    await page.click('#runBtn');

    const resultText = await page.$eval('#result', el => el.textContent);
    assert(resultText.includes('CORRECT'), `mul([[3,2],[5,7]])=[15,14] CORRECT: "${resultText.substring(0, 150)}"`);
}

// ============================================================
// Test 9: Tab switching back and forth
// ============================================================
async function testTabSwitching() {
    console.log('\n=== Test: Tab Switching ===');

    // Switch to Ambit
    await page.click('#tab-Ambit');
    await new Promise(r => setTimeout(r, 500));
    await waitForPrograms();

    let activeTab = await page.$eval('.tab-btn.active', t => t.textContent);
    assert(activeTab === 'Ambit', `After switch: Ambit active`);

    // Main should be hidden after switching (state reset)
    const mainHidden = await page.$eval('#main', el => el.style.display === 'none');
    assert(mainHidden, 'Main panel hidden after tab switch');

    // Check Ambit timing inputs replaced ReRAM ones
    const hasAAP = await page.$('#timing-AAP') !== null;
    assert(hasAAP, 'AAP timing input restored after switch to Ambit');

    // Switch back to ReRAM
    await page.click('#tab-ReRAM');
    await new Promise(r => setTimeout(r, 500));
    await waitForPrograms();

    activeTab = await page.$eval('.tab-btn.active', t => t.textContent);
    assert(activeTab === 'ReRAM', `After switch back: ReRAM active`);

    const hasNor2 = await page.$('#timing-nor2') !== null;
    assert(hasNor2, 'nor2 timing input after switch to ReRAM');

    // No JS errors
    assert(page._jsErrors.length === 0, `No JS errors during tab switching (${page._jsErrors.length})`);
}

// ============================================================
// Test 10: ReRAM column highlighting during stepping
// ============================================================
async function testReRAMColumnHighlighting() {
    console.log('\n=== Test: ReRAM Column Highlighting ===');

    const activeTab = await page.$eval('.tab-btn.active', t => t.textContent);
    if (activeTab !== 'ReRAM') {
        await page.click('#tab-ReRAM');
        await new Promise(r => setTimeout(r, 500));
        await waitForPrograms();
    }

    // Select abs program
    const absName = await page.evaluate(() => {
        const sel = document.getElementById('program');
        for (const opt of sel.options) {
            if (opt.value.includes('abs')) return opt.value;
        }
        return null;
    });
    if (!absName) return;

    await page.select('#program', absName);
    await page.evaluate(() => { document.getElementById('inputVal').value = '42'; });
    await page.click('#loadBtn');

    // Step once (past init to first real instruction)
    await page.click('#stepBtn');

    // Check if there are any cells with outline highlighting (from activated columns)
    const hasHighlightedCells = await page.evaluate(() => {
        const cells = document.querySelectorAll('#memory td[style*="outline"]');
        return cells.length > 0;
    });
    // After first step (init), all init cells should be highlighted
    // Step one more to get to inv1
    await page.click('#stepBtn');

    const hasHighlightedCells2 = await page.evaluate(() => {
        const cells = document.querySelectorAll('#memory td[style*="outline"]');
        return cells.length;
    });
    assert(hasHighlightedCells2 > 0, `Column cells highlighted after step: ${hasHighlightedCells2} cells`);

    // Check there's both yellow (active) and blue (previous) highlighting
    const hasYellow = await page.evaluate(() => {
        const cells = document.querySelectorAll('#memory td[style*="ffc107"]');
        return cells.length > 0;
    });
    const hasBlue = await page.evaluate(() => {
        const cells = document.querySelectorAll('#memory td[style*="17a2b8"]');
        return cells.length > 0;
    });
    assert(hasYellow, 'Yellow (active) column highlighting present');
    assert(hasBlue, 'Blue (previous) column highlighting present');
}

// ============================================================
// Test 11: ReRAM Legend
// ============================================================
async function testReRAMLegend() {
    console.log('\n=== Test: ReRAM Legend ===');

    // Should still be on ReRAM from previous test
    const legendText = await page.evaluate(() => {
        const memEl = document.getElementById('memory');
        return memEl ? memEl.textContent : '';
    });
    assert(legendText.includes('Input'), 'Legend contains Input');
    assert(legendText.includes('Output'), 'Legend contains Output');
    assert(legendText.includes('Active'), 'Legend contains Active');
    assert(legendText.includes('Previous'), 'Legend contains Previous');
}

// ============================================================
// Test 12: ReRAM signal name sub-header
// ============================================================
async function testReRAMSubHeader() {
    console.log('\n=== Test: ReRAM Rotated Header Labels ===');

    // Should still be on ReRAM with abs loaded
    // Headers now use rotated text with "index signalName" format
    const headerLabels = await page.evaluate(() => {
        const ths = document.querySelectorAll('#memory table tr:first-child th');
        const labels = [];
        for (const th of ths) {
            const text = th.textContent.trim();
            if (text && text !== 'Row') labels.push(text);
        }
        return labels;
    });
    assert(headerLabels.length > 0, `Rotated header labels present: [${headerLabels.slice(0, 5).join(', ')}...]`);
    assert(headerLabels.some(l => l.includes('A')), 'Header contains input signal labels (A*)');
    assert(headerLabels.some(l => l.includes('R')), 'Header contains output signal labels (R*)');
    // Check that labels include both cell index and signal name
    assert(headerLabels.some(l => /^\d+ \w+/.test(l)), 'Labels combine cell index and signal name');
}

// ============================================================
// Main
// ============================================================
async function main() {
    console.log('PIM Microprogram Visualizer - Headless Visual Tests\n');
    console.log('================================================\n');

    try {
        await setup();

        await testPageLoad();
        await testAmbitBackend();
        await testReRAMBackend();
        await testReRAMAbs();
        await testReRAMAdder();
        await testReRAMPopcount();
        await testReRAMSubtractor();
        await testReRAMMultiplier();
        await testTabSwitching();
        await testReRAMColumnHighlighting();
        await testReRAMLegend();
        await testReRAMSubHeader();

    } catch (err) {
        console.error('\nFATAL ERROR:', err.message);
        testsFailed++;
    } finally {
        await teardown();
    }

    console.log('\n================================================');
    console.log(`Results: ${testsPassed} passed, ${testsFailed} failed`);
    if (errors.length > 0) {
        console.log('\nFailed tests:');
        for (const e of errors) {
            console.log(`  - ${e}`);
        }
    }
    console.log('================================================\n');

    process.exit(testsFailed > 0 ? 1 : 0);
}

main();
