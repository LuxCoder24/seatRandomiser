// ===== Firebase imports =====
  import {
    auth, db,
    createUserWithEmailAndPassword,
    signInWithEmailAndPassword,
    sendPasswordResetEmail,
    signOut, onAuthStateChanged,
    doc, getDoc, setDoc
  } from './firebase-init.js';

  // ===== Classroom layout =====
  const TABLES = [
    { id: 't1', pos: 'r1', seats: [1, 2, 3, 4] },
    { id: 't2', pos: 'l1', seats: [5, 6, 7, 8] },
    { id: 't3', pos: 'r2', seats: [9, 10, 11, 12] },
    { id: 't4', pos: 'l2', seats: [13, 14, 15, 16] },
    { id: 't5', pos: 'r3', seats: [17, 18, 19, 20, 21, 22] },
    { id: 't6', pos: 'l3', seats: [23, 24, 25, 26] },
  ];
  const TOTAL_SEATS = TABLES.reduce((a, t) => a + t.seats.length, 0);
  const STORAGE_KEY = 'seat_randomiser_classes_v1';
  const HISTORY_LIMIT = 10;

  // ===== State =====
  const state = {
    classes: [],
    currentClassId: null,
    absent: new Set(),
    locks: {},         // seatNumber (string) -> studentName  -- tied to current loaded class
    editing: false,
    storageOK: false,
    activeTab: 'seating',

    // Seating mode
    currentSeating: null,     // seatNumber -> studentName for last shuffle
    seatingPast: [],
    seatingFuture: [],

    // Groups mode
    currentGroups: null,      // [[name, name], [name, name], ...]
    groupsPast: [],
    groupsFuture: [],

    // Cold call
    pickedSet: new Set(),
    pickedOrder: [],
    lastPicked: null,

    // Firebase
    currentUser: null,
    isLoading: false,
  };

  // ===== Storage (Firebase Firestore) =====
  // Each user's classes live in a single document at users/{uid}.
  // Document shape: { classes: [ {id, name, students, locks}, ... ] }

  async function loadFromStorage() {
    if (!state.currentUser) return;
    state.isLoading = true;
    try {
      const userDoc = doc(db, 'users', state.currentUser.uid);
      const snap = await getDoc(userDoc);
      if (snap.exists()) {
        const data = snap.data();
        if (Array.isArray(data.classes)) state.classes = data.classes;
      }
      state.storageOK = true;
    } catch (e) {
      console.error('Could not load classes from Firestore:', e);
      showStorageWarning('Could not load your saved classes. Check your internet connection.');
    } finally {
      state.isLoading = false;
    }
  }

  async function persistClasses() {
    if (!state.currentUser || !state.storageOK) return;
    try {
      const userDoc = doc(db, 'users', state.currentUser.uid);
      await setDoc(userDoc, { classes: state.classes }, { merge: true });
    } catch (e) {
      console.error('Could not save to Firestore:', e);
      showInfo('seating', 'Could not save — check your internet connection.', true);
    }
  }

  function showStorageWarning(msg) {
    const el = document.getElementById('storage-warning');
    el.textContent = msg;
    el.hidden = false;
  }

  // ===== Helpers =====
  function $(id) { return document.getElementById(id); }
  function getNames() {
    return $('names').value.split('\n').map(s => s.trim()).filter(Boolean);
  }
  function setNames(arr) { $('names').value = arr.join('\n'); }
  function uid() { return 'c_' + Date.now() + '_' + Math.random().toString(36).slice(2, 8); }
  function escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, c =>
      ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  }
  function shuffle(arr) {
    const a = [...arr];
    for (let i = a.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [a[i], a[j]] = [a[j], a[i]];
    }
    return a;
  }
  function findCurrentClass() {
    return state.classes.find(c => c.id === state.currentClassId) || null;
  }
  function isDirty() {
    const names = getNames();
    const c = findCurrentClass();
    if (!c) return names.length > 0 || Object.keys(state.locks).length > 0;
    if (JSON.stringify(c.students) !== JSON.stringify(names)) return true;
    return JSON.stringify(c.locks || {}) !== JSON.stringify(state.locks);
  }

  // ===== Rendering =====
  function renderClassroomScaffold() {
    const classroom = $('classroom');
    for (const t of TABLES) {
      const div = document.createElement('div');
      div.className = 'table unused';
      div.dataset.pos = t.pos;
      div.id = t.id;
      for (const s of t.seats) {
        const seat = document.createElement('button');
        seat.type = 'button';
        seat.className = 'seat';
        seat.dataset.seat = s;
        seat.innerHTML = `<span class="num">${s}</span>`;
        seat.addEventListener('click', () => openSeatPicker(s));
        div.appendChild(seat);
      }
      classroom.appendChild(div);
    }
  }

  function renderSeating() {
    const allNames = new Set(getNames());
    const seating = state.currentSeating || {};

    // Reset every seat to empty visual first
    for (const t of TABLES) {
      const tableEl = $(t.id);
      let anyHere = false;
      for (const s of t.seats) {
        const seatEl = tableEl.querySelector(`[data-seat="${s}"]`);
        seatEl.className = 'seat';
        seatEl.innerHTML = `<span class="num">${s}</span>`;

        const lockedName = state.locks[String(s)];
        const seatedName = seating[String(s)];

        if (lockedName && allNames.has(lockedName)) {
          seatEl.classList.add('locked');
          if (state.absent.has(lockedName)) seatEl.classList.add('absent-marked');
          seatEl.innerHTML =
            `<span class="num">${s}</span><span class="lock-icon">🔒</span>${escapeHtml(lockedName)}`;
          anyHere = true;
        } else if (seatedName && allNames.has(seatedName)) {
          seatEl.classList.add('filled');
          if (state.absent.has(seatedName)) seatEl.classList.add('absent-marked');
          seatEl.innerHTML = `<span class="num">${s}</span>${escapeHtml(seatedName)}`;
          anyHere = true;
        }
      }
      tableEl.classList.toggle('unused', !anyHere);
    }
  }

  function resetSeats(keepLocks = true) {
    state.currentSeating = null;
    if (!keepLocks) state.locks = {};
    renderSeating();
  }

  function renderClassSelector() {
    const sel = $('class-select');
    sel.innerHTML = '<option value="">— New class —</option>';
    const sorted = [...state.classes].sort((a, b) => a.name.localeCompare(b.name));
    for (const c of sorted) {
      const opt = document.createElement('option');
      opt.value = c.id;
      opt.textContent = c.name;
      if (c.id === state.currentClassId) opt.selected = true;
      sel.appendChild(opt);
    }
    $('rename-class').disabled = !state.currentClassId;
    $('delete-class').disabled = !state.currentClassId;
    $('save-class').textContent = state.currentClassId ? 'Save changes' : 'Save class…';
  }

  function renderChips() {
    const names = getNames();
    const nameSet = new Set(names);

    // Prune absences and locks for removed names
    for (const n of [...state.absent]) if (!nameSet.has(n)) state.absent.delete(n);
    for (const [s, n] of Object.entries(state.locks)) if (!nameSet.has(n)) delete state.locks[s];

    // Locked names (so we can show a 🔒 on the chip)
    const lockedNames = new Set(Object.values(state.locks));

    const container = $('chips');
    const hint = $('chips-hint');
    const allPresentBtn = $('all-present');
    const clearLocksBtn = $('clear-locks');

    container.innerHTML = '';
    if (names.length === 0) {
      container.innerHTML = '<p class="empty-state">No students yet. Click <strong>Edit list</strong> to add some.</p>';
      hint.hidden = true;
      allPresentBtn.hidden = true;
      clearLocksBtn.hidden = true;
    } else {
      hint.hidden = false;
      for (const name of names) {
        const chip = document.createElement('button');
        chip.type = 'button';
        let cls = 'chip';
        if (state.absent.has(name)) cls += ' absent';
        if (lockedNames.has(name)) cls += ' locked-indicator';
        chip.className = cls;
        chip.textContent = name;
        chip.title = state.absent.has(name) ? 'Click to mark present' : 'Click to mark absent';
        chip.addEventListener('click', () => {
          if (state.absent.has(name)) state.absent.delete(name);
          else state.absent.add(name);
          renderChips();
          renderSeating();
        });
        container.appendChild(chip);
      }
      allPresentBtn.hidden = state.absent.size === 0;
      clearLocksBtn.hidden = Object.keys(state.locks).length === 0;
    }

    // Counts
    const present = names.filter(n => !state.absent.has(n)).length;
    const absentCount = names.length - present;
    const lockCount = Object.keys(state.locks).length;
    const countsEl = $('counts');
    let parts = [];
    if (names.length > 0) {
      if (absentCount === 0) parts.push(`${present} student${present === 1 ? '' : 's'}`);
      else parts.push(`${present} present, <span class="absent-count">${absentCount} absent</span>`);
      if (lockCount > 0) parts.push(`<span class="lock-count">${lockCount} 🔒</span>`);
    }
    countsEl.innerHTML = parts.length ? '— ' + parts.join(' · ') : '';

    $('dirty-dot').classList.toggle('show', isDirty());
  }

  function setEditMode(editing) {
    state.editing = editing;
    $('edit-section').hidden = !editing;
    $('chips-section').hidden = editing;
    $('toggle-edit').textContent = editing ? 'Done' : 'Edit list';
    if (editing) $('names').focus();
    else { renderChips(); renderSeating(); }
  }

  // ===== Class actions =====
  function loadClass(id) {
    state.currentClassId = id || null;
    const c = findCurrentClass();
    setNames(c ? c.students : []);
    state.locks = c && c.locks ? { ...c.locks } : {};
    state.absent.clear();
    // Reset history & current view since this is a new class
    state.currentSeating = null;
    state.seatingPast = [];
    state.seatingFuture = [];
    state.currentGroups = null;
    state.groupsPast = [];
    state.groupsFuture = [];
    state.pickedSet = new Set();
    state.pickedOrder = [];
    state.lastPicked = null;

    renderClassSelector();
    renderChips();
    renderSeating();
    renderGroups();
    renderColdCall();
    updateHistoryButtons();
    setEditMode(getNames().length === 0);
    showInfo('seating', c ? `Loaded "${escapeHtml(c.name)}".` : 'Add names to start a new class.');
  }

  async function handleSave() {
    const names = getNames();
    if (names.length === 0) { showInfo('seating', 'Add at least one student before saving.', true); return; }
    if (state.currentClassId) {
      const c = findCurrentClass();
      c.students = names;
      c.locks = { ...state.locks };
      await persistClasses();
      renderChips();
      showToast('seating', `Saved "${c.name}".`);
    } else {
      await handleSaveAsNew();
    }
  }

  async function handleSaveAsNew() {
    const names = getNames();
    if (names.length === 0) { showInfo('seating', 'Add at least one student before saving.', true); return; }
    const name = (prompt('Name this class (e.g. "10A Maths"):') || '').trim();
    if (!name) return;
    if (state.classes.some(c => c.name === name)) {
      if (!confirm(`A class called "${name}" already exists. Save another with the same name?`)) return;
    }
    const id = uid();
    state.classes.push({ id, name, students: names, locks: { ...state.locks } });
    state.currentClassId = id;
    await persistClasses();
    renderClassSelector();
    renderChips();
    showToast('seating', `Saved as "${name}".`);
  }

  async function handleRename() {
    const c = findCurrentClass();
    if (!c) return;
    const name = (prompt('New name for this class:', c.name) || '').trim();
    if (!name || name === c.name) return;
    c.name = name;
    await persistClasses();
    renderClassSelector();
    showToast('seating', `Renamed to "${name}".`);
  }

  async function handleDelete() {
    const c = findCurrentClass();
    if (!c) return;
    if (!confirm(`Delete "${c.name}"? This cannot be undone.`)) return;
    state.classes = state.classes.filter(x => x.id !== c.id);
    state.currentClassId = null;
    setNames([]);
    state.locks = {};
    state.absent.clear();
    state.currentSeating = null;
    state.seatingPast = [];
    state.seatingFuture = [];
    await persistClasses();
    renderClassSelector();
    renderChips();
    renderSeating();
    setEditMode(false);
    showToast('seating', `Deleted "${c.name}".`);
  }

  // ===== Lock picker =====
  let pickerSeatNum = null;
  function openSeatPicker(seatNum) {
    if (state.activeTab !== 'seating') {
      // switch to seating tab
      switchTab('seating');
    }
    pickerSeatNum = seatNum;
    $('picker-seat-num').textContent = seatNum;
    $('picker-search').value = '';
    renderPickerOptions('');
    const dlg = $('seat-picker');
    if (typeof dlg.showModal === 'function') dlg.showModal();
    else dlg.setAttribute('open', '');
    setTimeout(() => $('picker-search').focus(), 50);
  }

  function closeSeatPicker() {
    const dlg = $('seat-picker');
    if (typeof dlg.close === 'function') dlg.close();
    else dlg.removeAttribute('open');
    pickerSeatNum = null;
  }

  function renderPickerOptions(filter) {
    const names = getNames();
    const f = filter.trim().toLowerCase();
    const filtered = f ? names.filter(n => n.toLowerCase().includes(f)) : names;
    const container = $('picker-options');
    container.innerHTML = '';
    if (filtered.length === 0) {
      container.innerHTML = '<p class="empty-state" style="padding: 12px;">No matches.</p>';
      return;
    }
    for (const name of filtered) {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'picker-option' + (state.absent.has(name) ? ' absent' : '');
      const lockedSeat = Object.entries(state.locks).find(([s, n]) => n === name);
      const meta = [];
      if (state.absent.has(name)) meta.push('absent');
      if (lockedSeat) meta.push(`now at seat ${lockedSeat[0]}`);
      btn.innerHTML = `<span class="name">${escapeHtml(name)}</span>` +
        (meta.length ? ` <span class="label-meta">(${meta.join(', ')})</span>` : '');
      btn.addEventListener('click', () => {
        applyLock(pickerSeatNum, name);
        closeSeatPicker();
      });
      container.appendChild(btn);
    }
  }

  function applyLock(seatNum, name) {
    const key = String(seatNum);
    // Remove any existing lock for this student elsewhere (one seat per student)
    for (const [s, n] of Object.entries(state.locks)) {
      if (n === name) delete state.locks[s];
    }
    state.locks[key] = name;
    persistClasses();  // auto-save if class is loaded
    renderChips();
    renderSeating();
    showInfo('seating', `Locked <strong>${escapeHtml(name)}</strong> to seat <strong>${seatNum}</strong>.`);
  }

  function clearLockAt(seatNum) {
    const key = String(seatNum);
    if (!state.locks[key]) return;
    const name = state.locks[key];
    delete state.locks[key];
    persistClasses();
    renderChips();
    renderSeating();
    showInfo('seating', `Unlocked seat <strong>${seatNum}</strong> (was <strong>${escapeHtml(name)}</strong>).`);
  }

  // ===== Seat assignment with locks =====
  // Pick used tables and per-table counts so we fill front-to-back, force tables
  // that contain locks to be used, and keep every used table at >= 3 where possible.
  function planAssignment(presentCount, locksPerTable) {
    // locksPerTable: array same length as TABLES, count of locked-and-present students per table
    const forced = TABLES.map((_, i) => locksPerTable[i] > 0);
    const usedIdx = [];
    let cap = 0;
    for (let i = 0; i < TABLES.length; i++) {
      if (forced[i] || cap < presentCount) {
        usedIdx.push(i);
        cap += TABLES[i].seats.length;
      }
    }

    // Initial counts: each table has at least its lock count, then fill remaining
    // capacity front-to-back through the used tables.
    const counts = usedIdx.map(i => locksPerTable[i]);
    let rem = presentCount - counts.reduce((a, b) => a + b, 0);
    for (let k = 0; k < usedIdx.length && rem > 0; k++) {
      const i = usedIdx[k];
      const space = TABLES[i].seats.length - counts[k];
      const take = Math.min(rem, space);
      counts[k] += take;
      rem -= take;
    }

    // Redistribute toward any under-3 used table, drawing from over-3 donors
    // who still have non-locked headroom (counts > locks).
    while (true) {
      const poorK = counts.findIndex((c, k) => c < 3 && c < TABLES[usedIdx[k]].seats.length);
      if (poorK === -1) break;
      const donorK = counts.findIndex((c, k) => c > 3 && c > locksPerTable[usedIdx[k]]);
      if (donorK === -1) break;
      counts[donorK]--;
      counts[poorK]++;
    }

    return { usedIdx, counts };
  }

  function randomise() {
    const allNames = getNames();
    const present = allNames.filter(n => !state.absent.has(n));

    if (allNames.length === 0) { showInfo('seating', 'Add some students first.', true); return; }
    if (present.length === 0) { showInfo('seating', 'Everyone is marked absent — no one to seat.', true); state.currentSeating = null; renderSeating(); return; }
    if (present.length > TOTAL_SEATS) { showInfo('seating', `Too many students (${present.length}). Maximum is ${TOTAL_SEATS}.`, true); return; }

    // Lock-related sets — only locks for present students apply
    const lockedSeatToName = {};   // string seatNum -> name
    const lockedNames = new Set();
    for (const [s, n] of Object.entries(state.locks)) {
      if (present.includes(n)) {
        lockedSeatToName[s] = n;
        lockedNames.add(n);
      }
    }
    const unlocked = present.filter(n => !lockedNames.has(n));

    // Per-table lock counts for planning
    const locksPerTable = TABLES.map(t =>
      t.seats.filter(s => lockedSeatToName[String(s)] !== undefined).length
    );

    const { usedIdx, counts } = planAssignment(present.length, locksPerTable);

    // Build the new seating
    const shuffled = shuffle(unlocked);
    const newSeating = {};
    let idx = 0;
    let undersized = 0;
    for (let k = 0; k < usedIdx.length; k++) {
      const i = usedIdx[k];
      const t = TABLES[i];
      const c = counts[k];
      if (c === 0) continue;
      if (c < 3) undersized++;

      const lockedHere = t.seats.filter(s => lockedSeatToName[String(s)] !== undefined);
      const openHere = t.seats.filter(s => lockedSeatToName[String(s)] === undefined);
      const needed = c - lockedHere.length;

      // Locks first
      for (const s of lockedHere) newSeating[String(s)] = lockedSeatToName[String(s)];

      // Then random subset of open seats
      const chosen = shuffle(openHere).slice(0, needed).sort((a, b) => a - b);
      for (const s of chosen) {
        newSeating[String(s)] = shuffled[idx];
        idx++;
      }
    }

    // Push current onto past, clear future
    if (state.currentSeating) state.seatingPast.push(state.currentSeating);
    if (state.seatingPast.length > HISTORY_LIMIT) state.seatingPast.shift();
    state.seatingFuture = [];
    state.currentSeating = newSeating;

    renderSeating();
    updateHistoryButtons();

    const tablesUsed = counts.filter(c => c > 0).length;
    const studentWord = present.length === 1 ? 'student' : 'students';
    const tableWord = tablesUsed === 1 ? 'table' : 'tables';
    const absentNote = state.absent.size > 0 ? ` (${state.absent.size} absent)` : '';
    const lockNote = lockedNames.size > 0 ? `, ${lockedNames.size} locked` : '';
    let msg = `<strong>${present.length}</strong> ${studentWord}${absentNote}${lockNote} seated across <strong>${tablesUsed}</strong> ${tableWord}.`;
    if (undersized > 0) msg += ` <em>(${undersized} table with fewer than 3 — not enough flexibility to avoid it.)</em>`;
    showInfo('seating', msg);
  }

  function seatingUndo() {
    if (state.seatingPast.length === 0) return;
    if (state.currentSeating) state.seatingFuture.push(state.currentSeating);
    state.currentSeating = state.seatingPast.pop();
    renderSeating();
    updateHistoryButtons();
    showInfo('seating', 'Reverted to previous seating.');
  }
  function seatingRedo() {
    if (state.seatingFuture.length === 0) return;
    if (state.currentSeating) state.seatingPast.push(state.currentSeating);
    state.currentSeating = state.seatingFuture.pop();
    renderSeating();
    updateHistoryButtons();
    showInfo('seating', 'Reapplied seating.');
  }

  // ===== Groups mode =====
  function renderGroups() {
    const wrap = $('groups-display');
    if (!state.currentGroups) { wrap.innerHTML = ''; return; }
    const allNames = new Set(getNames());
    let html = '<div class="groups-grid">';
    state.currentGroups.forEach((group, i) => {
      const liveMembers = group.filter(n => allNames.has(n));
      html += `<div class="group-card">
        <h4><span>Group <span class="group-num">${i + 1}</span></span><span class="group-size">${liveMembers.length} ${liveMembers.length === 1 ? 'student' : 'students'}</span></h4>
        <ul>` +
        liveMembers.map(n => {
          const absent = state.absent.has(n);
          return `<li${absent ? ' style="text-decoration: line-through; color: var(--ink-soft);"' : ''}>${escapeHtml(n)}${absent ? ' <em style="color: var(--accent); font-size: 11px;">(absent)</em>' : ''}</li>`;
        }).join('') + '</ul></div>';
    });
    html += '</div>';
    wrap.innerHTML = html;
  }

  function makeGroups() {
    const allNames = getNames();
    const present = allNames.filter(n => !state.absent.has(n));
    if (present.length === 0) { showInfo('groups', 'No present students to group.', true); return; }

    const mode = $('group-mode').value;
    const value = parseInt($('group-value').value, 10);
    if (!Number.isFinite(value) || value < 1) { showInfo('groups', 'Pick a number ≥ 1.', true); return; }

    let numGroups;
    if (mode === 'count') {
      numGroups = Math.min(value, present.length);
    } else {
      numGroups = Math.max(1, Math.ceil(present.length / value));
    }

    // Distribute as evenly as possible: round-robin into groups
    const shuffled = shuffle(present);
    const groups = Array.from({ length: numGroups }, () => []);
    shuffled.forEach((n, i) => groups[i % numGroups].push(n));

    // Push current to past
    if (state.currentGroups) state.groupsPast.push(state.currentGroups);
    if (state.groupsPast.length > HISTORY_LIMIT) state.groupsPast.shift();
    state.groupsFuture = [];
    state.currentGroups = groups;

    renderGroups();
    updateHistoryButtons();

    const sizes = groups.map(g => g.length);
    const min = Math.min(...sizes), max = Math.max(...sizes);
    const sizeText = min === max ? `${min} per group` : `${min}–${max} per group`;
    showInfo('groups', `Made <strong>${numGroups}</strong> group${numGroups === 1 ? '' : 's'} from <strong>${present.length}</strong> present (${sizeText}).`);
  }

  function groupsUndo() {
    if (state.groupsPast.length === 0) return;
    if (state.currentGroups) state.groupsFuture.push(state.currentGroups);
    state.currentGroups = state.groupsPast.pop();
    renderGroups();
    updateHistoryButtons();
    showInfo('groups', 'Reverted to previous groups.');
  }
  function groupsRedo() {
    if (state.groupsFuture.length === 0) return;
    if (state.currentGroups) state.groupsPast.push(state.currentGroups);
    state.currentGroups = state.groupsFuture.pop();
    renderGroups();
    updateHistoryButtons();
    showInfo('groups', 'Reapplied groups.');
  }

  // ===== Cold call =====
  function renderColdCall() {
    const allNames = getNames();
    const present = allNames.filter(n => !state.absent.has(n));

    // Prune picked set for removed/absent names
    for (const n of [...state.pickedSet]) {
      if (!present.includes(n)) state.pickedSet.delete(n);
    }
    state.pickedOrder = state.pickedOrder.filter(n => present.includes(n));

    const nameEl = $('picked-name');
    if (state.lastPicked && present.includes(state.lastPicked)) {
      nameEl.textContent = state.lastPicked;
      nameEl.classList.remove('placeholder');
    } else {
      nameEl.textContent = present.length === 0 ? 'No present students' : '— click pick —';
      nameEl.classList.add('placeholder');
    }

    const noRepeats = $('no-repeats').checked;
    const progBar = $('progress-bar');
    const progText = $('progress-text');
    const histWrap = $('picked-history');

    if (noRepeats && present.length > 0 && state.pickedOrder.length > 0) {
      progBar.hidden = false;
      progText.hidden = false;
      histWrap.hidden = false;
      const pct = Math.round((state.pickedSet.size / present.length) * 100);
      $('progress-fill').style.width = pct + '%';
      progText.textContent = `${state.pickedSet.size} of ${present.length} picked this round`;

      const chips = $('picked-history-chips');
      chips.innerHTML = '';
      for (const n of state.pickedOrder) {
        const c = document.createElement('span');
        c.className = 'chip';
        c.textContent = n;
        chips.appendChild(c);
      }
    } else {
      progBar.hidden = true;
      progText.hidden = true;
      histWrap.hidden = true;
    }
  }

  function pickStudent() {
    const allNames = getNames();
    const present = allNames.filter(n => !state.absent.has(n));
    if (present.length === 0) { showInfo('coldcall', 'No present students to pick from.', true); return; }

    const noRepeats = $('no-repeats').checked;
    let pool = present;
    let resetMessage = '';
    if (noRepeats) {
      pool = present.filter(n => !state.pickedSet.has(n));
      if (pool.length === 0) {
        // Reset round
        state.pickedSet.clear();
        state.pickedOrder = [];
        pool = present;
        resetMessage = ' (round reset — everyone has been picked)';
      }
    }

    // Avoid picking the same person twice in a row when there's a choice
    let candidates = pool;
    if (pool.length > 1 && state.lastPicked && pool.includes(state.lastPicked)) {
      candidates = pool.filter(n => n !== state.lastPicked);
    }

    const pick = candidates[Math.floor(Math.random() * candidates.length)];
    state.lastPicked = pick;
    if (noRepeats) {
      state.pickedSet.add(pick);
      state.pickedOrder.push(pick);
    }
    renderColdCall();
    showInfo('coldcall', `Picked <strong>${escapeHtml(pick)}</strong>.${resetMessage}`);
  }

  function resetPicked() {
    state.pickedSet.clear();
    state.pickedOrder = [];
    state.lastPicked = null;
    renderColdCall();
    showInfo('coldcall', 'History cleared.');
  }

  // ===== Tabs =====
  function switchTab(tab) {
    state.activeTab = tab;
    document.querySelectorAll('.tab').forEach(el => {
      el.classList.toggle('active', el.dataset.tab === tab);
    });
    $('tab-seating').hidden = tab !== 'seating';
    $('tab-groups').hidden = tab !== 'groups';
    $('tab-coldcall').hidden = tab !== 'coldcall';
  }

  // ===== History buttons =====
  function updateHistoryButtons() {
    $('seating-undo').disabled = state.seatingPast.length === 0;
    $('seating-redo').disabled = state.seatingFuture.length === 0;
    $('groups-undo').disabled = state.groupsPast.length === 0;
    $('groups-redo').disabled = state.groupsFuture.length === 0;
  }

  // ===== Notifications =====
  function showInfo(scope, html, isError = false) {
    const el = $(scope + '-info');
    if (!el) return;
    el.classList.toggle('error', isError);
    el.innerHTML = html;
  }
  const toastTimers = {};
  function showToast(scope, text) {
    const el = $(scope + '-info');
    if (!el) return;
    el.classList.remove('error');
    el.innerHTML = `<span style="color: var(--sage); font-weight: 600; font-style: normal; font-family: inherit;">✓</span> ${escapeHtml(text)}`;
    clearTimeout(toastTimers[scope]);
    toastTimers[scope] = setTimeout(() => {
      if (!isDirty()) showInfo(scope, 'Ready to randomise.');
    }, 2500);
  }

  // ===== Init =====
  function init() {
    renderClassroomScaffold();
    renderChips();
    renderSeating();
    renderClassSelector();
    renderColdCall();
    setEditMode(true);

    // Class controls
    $('class-select').addEventListener('change', (e) => {
      if (isDirty() && !confirm('You have unsaved changes. Switch class anyway?')) {
        renderClassSelector();
        return;
      }
      loadClass(e.target.value);
    });
    $('save-class').addEventListener('click', handleSave);
    $('save-class-as').addEventListener('click', handleSaveAsNew);
    $('rename-class').addEventListener('click', handleRename);
    $('delete-class').addEventListener('click', handleDelete);

    // Roster controls
    $('toggle-edit').addEventListener('click', () => setEditMode(!state.editing));
    $('names').addEventListener('input', () => {
      $('dirty-dot').classList.toggle('show', isDirty());
    });
    $('all-present').addEventListener('click', () => {
      state.absent.clear();
      renderChips();
      renderSeating();
    });
    $('clear-locks').addEventListener('click', () => {
      if (!confirm('Clear all seat locks for this class?')) return;
      state.locks = {};
      persistClasses();
      renderChips();
      renderSeating();
    });

    // Tabs
    document.querySelectorAll('.tab').forEach(el => {
      el.addEventListener('click', () => switchTab(el.dataset.tab));
    });

    // Seating
    $('randomise').addEventListener('click', () => {
      if (state.editing) setEditMode(false);
      randomise();
    });
    $('seating-undo').addEventListener('click', seatingUndo);
    $('seating-redo').addEventListener('click', seatingRedo);

    // Groups
    $('make-groups').addEventListener('click', () => {
      if (state.editing) setEditMode(false);
      makeGroups();
    });
    $('groups-undo').addEventListener('click', groupsUndo);
    $('groups-redo').addEventListener('click', groupsRedo);
    $('group-mode').addEventListener('change', () => {
      const mode = $('group-mode').value;
      $('group-value').value = mode === 'count' ? 4 : 4;
    });

    // Cold call
    $('pick-student').addEventListener('click', () => {
      if (state.editing) setEditMode(false);
      pickStudent();
    });
    $('reset-picked').addEventListener('click', resetPicked);
    $('no-repeats').addEventListener('change', renderColdCall);

    // Seat picker
    $('picker-search').addEventListener('input', (e) => renderPickerOptions(e.target.value));
    $('picker-clear').addEventListener('click', () => {
      if (pickerSeatNum != null) clearLockAt(pickerSeatNum);
      closeSeatPicker();
    });
    $('picker-cancel').addEventListener('click', closeSeatPicker);
    $('picker-close-x').addEventListener('click', closeSeatPicker);
    $('seat-picker').addEventListener('click', (e) => {
      // Click on backdrop closes the dialog
      if (e.target === $('seat-picker')) closeSeatPicker();
    });

    // Keyboard shortcuts
    $('names').addEventListener('keydown', (e) => {
      if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') {
        e.preventDefault();
        setEditMode(false);
        randomise();
      }
    });
    document.addEventListener('keydown', (e) => {
      // Ignore when typing in inputs
      const tag = (e.target.tagName || '').toLowerCase();
      if (tag === 'textarea' || tag === 'input') return;
      if ((e.ctrlKey || e.metaKey) && e.key === 'z' && !e.shiftKey) {
        if (state.activeTab === 'seating') { e.preventDefault(); seatingUndo(); }
        else if (state.activeTab === 'groups') { e.preventDefault(); groupsUndo(); }
      }
      if ((e.ctrlKey || e.metaKey) && (e.key === 'Z' || (e.key === 'z' && e.shiftKey))) {
        if (state.activeTab === 'seating') { e.preventDefault(); seatingRedo(); }
        else if (state.activeTab === 'groups') { e.preventDefault(); groupsRedo(); }
      }
    });

    // Warn before leaving with unsaved changes
    window.addEventListener('beforeunload', (e) => {
      if (isDirty() && state.storageOK) {
        e.preventDefault();
        e.returnValue = '';
      }
    });

    updateHistoryButtons();
  }

  // ===== Auth flow =====
  // Three modes: 'signin' | 'register' | 'reset'
  let authMode = 'signin';

  const AUTH_TEXT = {
    signin:   { subtitle: 'Sign in to access your saved classes.', submit: 'Sign In', autocomplete: 'current-password' },
    register: { subtitle: 'Create an account to save classes in the cloud.', submit: 'Create Account', autocomplete: 'new-password' },
    reset:    { subtitle: "Enter your email and we'll send you a reset link.", submit: 'Send Reset Email', autocomplete: 'email' },
  };

  function setAuthMode(mode) {
    authMode = mode;
    const t = AUTH_TEXT[mode];
    document.getElementById('auth-subtitle').textContent = t.subtitle;
    document.getElementById('auth-submit').textContent = t.submit;

    // Re-enable the submit button (in case it was stuck disabled)
    document.getElementById('auth-submit').disabled = false;

    // Show/hide password field for reset mode
    document.getElementById('password-field').hidden = (mode === 'reset');

    // Password hint only for register
    document.getElementById('password-hint').hidden = (mode !== 'register');

    // Update autocomplete to help password managers
    const pwInput = document.getElementById('auth-password');
    pwInput.setAttribute('autocomplete', t.autocomplete);
    pwInput.value = ''; // clear password between modes

    // Show the right set of links (single signin-links or back-link)
    document.getElementById('signin-links').hidden = (mode !== 'signin');
    document.getElementById('back-link').hidden = (mode === 'signin');

    // Clear any previous messages
    document.getElementById('login-error').hidden = true;
    document.getElementById('login-success').hidden = true;
  }

  function showAuthError(msg) {
    const err = document.getElementById('login-error');
    err.textContent = msg;
    err.hidden = false;
    document.getElementById('login-success').hidden = true;
  }
  function showAuthSuccess(msg) {
    const ok = document.getElementById('login-success');
    ok.textContent = msg;
    ok.hidden = false;
    document.getElementById('login-error').hidden = true;
  }

  // Translate Firebase auth error codes into friendly messages
  function friendlyAuthError(code) {
    switch (code) {
      case 'auth/invalid-email': return 'That email address doesn\'t look right.';
      case 'auth/user-not-found': return 'No account exists with that email.';
      case 'auth/wrong-password':
      case 'auth/invalid-credential': return 'Email or password is incorrect.';
      case 'auth/email-already-in-use': return 'An account with that email already exists. Try signing in instead.';
      case 'auth/weak-password': return 'Password must be at least 6 characters.';
      case 'auth/too-many-requests': return 'Too many failed attempts. Try again in a few minutes.';
      case 'auth/network-request-failed': return 'No internet connection. Check your network.';
      case 'auth/missing-password': return 'Please enter your password.';
      default: return 'Sign-in failed: ' + code;
    }
  }

  async function handleAuthSubmit() {
    const email = document.getElementById('auth-email').value.trim();
    const password = document.getElementById('auth-password').value;

    if (!email) { showAuthError('Please enter your email address.'); return; }

    const submitBtn = document.getElementById('auth-submit');
    const originalText = submitBtn.textContent;
    submitBtn.disabled = true;
    submitBtn.textContent = (authMode === 'reset') ? 'Sending…' : 'Working…';
    document.getElementById('login-error').hidden = true;
    document.getElementById('login-success').hidden = true;

    console.log('[auth] Submitting in mode:', authMode, 'for email:', email);

    try {
      if (authMode === 'signin') {
        if (!password) { showAuthError('Please enter your password.'); return; }
        console.log('[auth] Calling signInWithEmailAndPassword');
        const cred = await signInWithEmailAndPassword(auth, email, password);
        console.log('[auth] Sign-in succeeded for:', cred.user.email);
        // onAuthStateChanged will fire and show the app
      } else if (authMode === 'register') {
        if (!password || password.length < 6) {
          showAuthError('Password must be at least 6 characters.');
          return;
        }
        console.log('[auth] Calling createUserWithEmailAndPassword');
        const cred = await createUserWithEmailAndPassword(auth, email, password);
        console.log('[auth] Account created for:', cred.user.email, '— now auto-signed-in');
        // onAuthStateChanged will fire and show the app
      } else if (authMode === 'reset') {
        console.log('[auth] Sending password reset email');
        await sendPasswordResetEmail(auth, email);
        showAuthSuccess('Reset email sent. Check your inbox (and spam folder).');
        document.getElementById('auth-email').value = '';
      }
    } catch (e) {
      console.error('[auth] Error:', e.code, e.message);
      showAuthError(friendlyAuthError(e.code || e.message));
    } finally {
      submitBtn.disabled = false;
      submitBtn.textContent = originalText;
    }
  }

  async function handleSignOut() {
    if (!confirm('Sign out?')) return;
    try {
      await signOut(auth);
    } catch (e) {
      console.error('Sign-out failed:', e);
    }
  }

  function showLoginScreen() {
    document.getElementById('login-overlay').hidden = false;
    document.getElementById('app-content').hidden = true;
  }

  function showApp(user) {
    document.getElementById('login-overlay').hidden = true;
    document.getElementById('app-content').hidden = false;
    const nameEl = document.getElementById('user-name');
    if (nameEl) nameEl.textContent = user.email || 'Signed in';
  }

  function clearLocalState() {
    state.classes = [];
    state.currentClassId = null;
    state.absent.clear();
    state.locks = {};
    state.currentSeating = null;
    state.seatingPast = [];
    state.seatingFuture = [];
    state.currentGroups = null;
    state.groupsPast = [];
    state.groupsFuture = [];
    state.pickedSet = new Set();
    state.pickedOrder = [];
    state.lastPicked = null;
  }

  let initialised = false;

  onAuthStateChanged(auth, async (user) => {
    console.log('[auth] State changed. User:', user ? user.email : 'signed out');
    if (user) {
      state.currentUser = user;
      showApp(user);
      await loadFromStorage();
      console.log('[auth] Loaded classes from Firestore. Count:', state.classes.length);
      if (!initialised) {
        init();
        initialised = true;
      } else {
        // Re-render with the new user's data
        renderClassSelector();
        renderChips();
        renderSeating();
        renderColdCall();
        setEditMode(getNames().length === 0);
      }
    } else {
      state.currentUser = null;
      state.storageOK = false;
      clearLocalState();
      if (initialised) {
        renderClassSelector();
        renderChips();
        renderSeating();
        renderColdCall();
      }
      showLoginScreen();
    }
  });

  // Wire up the auth form
  document.getElementById('auth-submit').addEventListener('click', handleAuthSubmit);
  document.getElementById('to-register-link').addEventListener('click', (e) => {
    e.preventDefault();
    setAuthMode('register');
  });
  document.getElementById('forgot-link').addEventListener('click', (e) => {
    e.preventDefault();
    setAuthMode('reset');
  });
  document.getElementById('back-to-signin').addEventListener('click', (e) => {
    e.preventDefault();
    setAuthMode('signin');
  });
  // Submit on Enter key in email or password
  ['auth-email', 'auth-password'].forEach(id => {
    document.getElementById(id).addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        e.preventDefault();
        handleAuthSubmit();
      }
    });
  });

  // Sign-out button
  const signOutBtn = document.getElementById('signout-btn');
  if (signOutBtn) signOutBtn.addEventListener('click', handleSignOut);