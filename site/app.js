const labels = {
  classes: { select: 'Класс или группа', search: 'Например, 7а', eyebrow: 'РАСПИСАНИЕ КЛАССА' },
  teachers: { select: 'Учитель', search: 'Введите фамилию', eyebrow: 'РАСПИСАНИЕ УЧИТЕЛЯ' },
  rooms: { select: 'Кабинет', search: 'Например, 212', eyebrow: 'РАСПИСАНИЕ КАБИНЕТА' }
};
const state = { datasets: { classes: new Map(), teachers: new Map(), rooms: new Map() }, substitutions: [], view: 'classes', selected: {}, selectedDay: '' };
const ALL_DAYS = 'Вся неделя';
const $ = (id) => document.getElementById(id);

function clean(cell) {
  if (!cell) return '';
  const copy = cell.cloneNode(true);
  copy.querySelectorAll?.('br').forEach((br) => br.replaceWith('\n'));
  return copy.textContent.replace(/\u00a0/g, ' ').replace(/\s*\n\s*/g, ' / ').replace(/\s+/g, ' ').trim();
}
function naturalRu(a, b) { return a.localeCompare(b, 'ru', { numeric: true, sensitivity: 'base' }); }
function put(view, name, day, lesson, keepEmpty = false) {
  if (!name || !day) return;
  const data = state.datasets[view];
  if (!data.has(name)) data.set(name, new Map());
  if (!data.get(name).has(day)) data.get(name).set(day, []);
  if (keepEmpty || lesson.primary || lesson.secondary) data.get(name).get(day).push(lesson);
}
async function fetchCp1251(url) {
  const response = await fetch(`${url}?v=${Date.now()}`, { cache: 'no-store' });
  if (!response.ok) throw new Error(`Не удалось загрузить ${url}`);
  return new TextDecoder('windows-1251').decode(await response.arrayBuffer());
}
function pageNames(indexHtml) {
  return [...indexHtml.matchAll(/(?:^|[\\/])?(index\d+\.html?)/gi)].map((m) => m[1].toLowerCase())
    .filter((name, i, all) => all.indexOf(name) === i).sort(naturalRu);
}

function parseClasses(html) {
  const doc = new DOMParser().parseFromString(html, 'text/html');
  for (const heading of doc.querySelectorAll('h2')) {
    const match = clean(heading).match(/^День\s*-\s*(.+)$/i);
    if (!match) continue;
    const day = match[1].trim(); let table = heading.nextElementSibling;
    while (table && table.tagName !== 'TABLE') table = table.nextElementSibling;
    if (!table) continue;
    const rows = [...table.querySelectorAll('tr')];
    const names = [...rows[0].querySelectorAll('th[colspan="2"]')].map(clean);
    rows.slice(2).forEach((row) => {
      const cells = [...row.querySelectorAll('th,td')]; const number = Number(clean(cells[0])); if (!number) return;
      names.forEach((name, i) => put('classes', name, day, { number, primary: clean(cells[1 + i * 2]), secondary: clean(cells[2 + i * 2]), teachers: [] }, true));
    });
  }
}

function parseTeachers(html) {
  const doc = new DOMParser().parseFromString(html, 'text/html');
  for (const table of doc.querySelectorAll('table')) {
    const rows = [...table.querySelectorAll('tr')]; if (rows.length < 4) continue;
    const dayCells = [...rows[0].querySelectorAll('th')];
    const day = clean(dayCells[dayCells.length - 1]);
    const numbers = [...rows[1].querySelectorAll('th')].map(clean).map(Number).filter(Boolean);
    if (!day || !numbers.length) continue;
    rows.slice(3).forEach((row) => {
      const cells = [...row.querySelectorAll('th,td')]; const teacher = clean(cells[1]); if (!teacher) return;
      numbers.forEach((number, i) => put('teachers', teacher, day, { number, primary: clean(cells[2 + i * 2]), secondary: clean(cells[3 + i * 2]) }, true));
    });
  }
}

function parseRooms(html) {
  const doc = new DOMParser().parseFromString(html, 'text/html');
  for (const heading of doc.querySelectorAll('h2')) {
    const room = clean(heading); let table = heading.nextElementSibling;
    while (table && table.tagName !== 'TABLE') table = table.nextElementSibling;
    if (!room || !table) continue;
    const rows = [...table.querySelectorAll('tr')]; if (rows.length < 3) continue;
    const days = [...rows[0].querySelectorAll('th')].slice(1).map(clean);
    rows.slice(2).forEach((row) => {
      const cells = [...row.querySelectorAll('th,td')]; const number = Number(clean(cells[0])); if (!number) return;
      days.forEach((day, i) => {
        const raw = clean(cells[i + 1]); const parts = raw.split(',').map((part) => part.trim()).filter(Boolean);
        put('rooms', room, day, { number, primary: parts.length > 2 ? parts.slice(2).join(', ') : raw, secondary: parts.length > 1 ? `${parts[0]} · ${parts[1]}` : '' }, true);
      });
    });
  }
}

async function loadDataset(view, parser) {
  const index = await fetchCp1251(`/data/${view}/index.html`);
  const pages = pageNames(index);
  if (!pages.length) parser(index);
  else (await Promise.all(pages.map((name) => fetchCp1251(`/data/${view}/${name}`)))).forEach(parser);
  if (!state.datasets[view].size) throw new Error(`Не удалось прочитать раздел «${labels[view].select}»`);
}
async function loadVersion() {
  const response = await fetch(`/data/version.json?v=${Date.now()}`, { cache: 'no-store' }); if (!response.ok) return;
  const version = await response.json(); const date = new Date(version.sourceModified);
  $('updated').textContent = `Обновлено: ${new Intl.DateTimeFormat('ru-RU', { dateStyle: 'short', timeStyle: 'short' }).format(date)}`;
}
function classKey(value) {
  return value.toLocaleLowerCase('ru').replace(/\s+/g, '');
}
function addTeachersToClasses() {
  const index = new Map();
  for (const [teacher, days] of state.datasets.teachers) {
    for (const [day, lessons] of days) {
      for (const lesson of lessons) {
        if (!lesson.primary) continue;
        const classNames = lesson.primary.split(/\s*(?:\/|,|;|\n)\s*/).filter(Boolean);
        for (const className of classNames) {
          const key = `${day}|${lesson.number}|${classKey(className)}`;
          if (!index.has(key)) index.set(key, new Set());
          index.get(key).add(teacher);
        }
      }
    }
  }
  for (const [className, days] of state.datasets.classes) {
    for (const [day, lessons] of days) {
      for (const lesson of lessons) {
        lesson.teachers = [...(index.get(`${day}|${lesson.number}|${classKey(className)}`) || [])].sort(naturalRu);
      }
    }
  }
}
async function loadSubstitutions() {
  try {
    const response = await fetch(`/api/schedule-upload/substitutions?v=${Date.now()}`, { cache: 'no-store' });
    if (!response.ok) { state.substitutions = []; return; }
    const result = await response.json();
    state.substitutions = Array.isArray(result.substitutions) ? result.substitutions : [];
  } catch {
    state.substitutions = [];
  }
}
function applySubstitutions() {
  for (const substitution of state.substitutions) {
    const classLesson = state.datasets.classes.get(substitution.className)?.get(substitution.day)?.find((lesson) => lesson.number === Number(substitution.lesson));
    if (!classLesson) continue;
    classLesson.substitution = substitution;
    const absentLesson = state.datasets.teachers.get(substitution.absentTeacher)?.get(substitution.day)?.find((lesson) => lesson.number === Number(substitution.lesson));
    const period = substitution.dateFrom && substitution.dateTo ? ` (${formatShortDate(substitution.dateFrom)}–${formatShortDate(substitution.dateTo)})` : '';
    if (absentLesson) absentLesson.substitutionNote = `Замена${period}: ${substitution.replacementTeacher}`;
    const replacementDays = state.datasets.teachers.get(substitution.replacementTeacher);
    if (!replacementDays) continue;
    if (!replacementDays.has(substitution.day)) replacementDays.set(substitution.day, []);
    let replacementLesson = replacementDays.get(substitution.day).find((lesson) => lesson.number === Number(substitution.lesson));
    if (!replacementLesson) {
      replacementLesson = { number: Number(substitution.lesson), primary: '', secondary: '' };
      replacementDays.get(substitution.day).push(replacementLesson);
    }
    if (replacementLesson.isReplacement && replacementLesson.substitutionNote?.includes(substitution.absentTeacher)) {
      const classes = new Set(replacementLesson.primary.split(', ').filter(Boolean));
      classes.add(substitution.className);
      replacementLesson.primary = [...classes].join(', ');
      const rooms = new Set(replacementLesson.secondary.split(' / ').filter(Boolean));
      for (const room of classLesson.secondary.split(' / ').filter(Boolean)) rooms.add(room);
      replacementLesson.secondary = [...rooms].join(' / ');
    } else {
      replacementLesson.primary = substitution.className;
      replacementLesson.secondary = classLesson.secondary;
    }
    replacementLesson.substitutionNote = `Замена${period} вместо ${substitution.absentTeacher}`;
    replacementLesson.isReplacement = true;
  }
}
async function load() {
  Object.values(state.datasets).forEach((data) => data.clear());
  $('notice').hidden = true; $('schedule').innerHTML = '<div class="skeleton"></div><div class="skeleton"></div><div class="skeleton"></div>';
  try {
    await loadVersion();
    await Promise.all([loadDataset('classes', parseClasses), loadDataset('teachers', parseTeachers), loadDataset('rooms', parseRooms), loadSubstitutions()]);
    addTeachersToClasses();
    applySubstitutions();
    for (const view of Object.keys(labels)) {
      const names = [...state.datasets[view].keys()].sort(naturalRu);
      const remembered = localStorage.getItem(`schedule-${view}`);
      state.selected[view] = names.includes(remembered) ? remembered : names[0];
    }
    switchView(state.view);
  } catch (error) {
    $('heading').textContent = 'Расписание временно недоступно'; $('schedule').innerHTML = '';
    $('notice').textContent = error.message; $('notice').hidden = false; $('updated').textContent = 'Ошибка обновления';
  }
}
function activeDays(view = state.view) {
  const all = [...state.datasets[view].values()].flatMap((days) => [...days.keys()]);
  const order = ['Понедельник','Вторник','Среда','Четверг','Пятница','Суббота','Воскресенье'];
  return [...new Set(all)].sort((a,b) => order.indexOf(a) - order.indexOf(b));
}
function defaultDay(days) {
  const today = new Intl.DateTimeFormat('ru-RU', { weekday: 'long' }).format(new Date());
  return days.find((d) => d.toLocaleLowerCase('ru') === today.toLocaleLowerCase('ru')) || days[0];
}
function switchView(view) {
  state.view = view; const meta = labels[view]; const days = activeDays();
  if (state.selectedDay !== ALL_DAYS && !days.includes(state.selectedDay)) state.selectedDay = defaultDay(days);
  document.querySelectorAll('.view').forEach((button) => button.classList.toggle('active', button.dataset.view === view));
  $('selectTitle').textContent = meta.select; $('classSearch').placeholder = meta.search; $('classSearch').value = ''; $('eyebrow').textContent = meta.eyebrow;
  populateOptions(); populateDays(days); render();
}
function populateOptions(filter = '') {
  const names = [...state.datasets[state.view].keys()].sort(naturalRu).filter((n) => n.toLocaleLowerCase('ru').includes(filter.toLocaleLowerCase('ru')));
  if (!names.includes(state.selected[state.view]) && names.length) state.selected[state.view] = names[0];
  $('classSelect').innerHTML = names.map((name) => `<option value="${escapeHtml(name)}">${escapeHtml(name)}</option>`).join('');
  $('classSelect').value = state.selected[state.view]; $('classSelect').disabled = false;
}
function populateDays(days = activeDays()) {
  $('days').innerHTML = [ALL_DAYS, ...days].map((day) => `<button type="button" class="day${day === state.selectedDay ? ' active' : ''}" data-day="${escapeHtml(day)}">${escapeHtml(day)}</button>`).join('');
}
function prepareLessons(lessons) {
  lessons = [...lessons].sort((a,b) => a.number-b.number);
  const lastOccupied = lessons.findLastIndex((lesson) => lesson.primary || lesson.secondary);
  return lastOccupied >= 0 ? lessons.slice(0, lastOccupied + 1) : [];
}
function renderLessons(lessons) {
  if (!lessons.length) return '<div class="empty-day compact">Занятий нет</div>';
  return lessons.map((lesson) => {
    const empty = !lesson.primary && !lesson.secondary;
    const subject = empty
      ? '<span class="part no-lesson">Нет урока</span>'
      : lesson.primary.split(' / ').map((part) => `<span class="part">${escapeHtml(part)}</span>`).join('');
    let teachers = '';
    if (state.view === 'classes' && lesson.teachers?.length) {
      const period = lesson.substitution?.dateFrom && lesson.substitution?.dateTo ? ` ${formatShortDate(lesson.substitution.dateFrom)}–${formatShortDate(lesson.substitution.dateTo)}` : '';
      teachers = `<div class="teachers" aria-label="Учителя">${lesson.teachers.map((teacher) => `<span class="teacher${lesson.substitution?.absentTeacher === teacher ? ' absent' : ''}">${escapeHtml(teacher)}</span>`).join('')}${lesson.substitution ? `<span class="teacher replacement">Замена${period}: ${escapeHtml(lesson.substitution.replacementTeacher)}</span>` : ''}</div>`;
    } else if (state.view === 'teachers' && lesson.substitutionNote) {
      teachers = `<div class="teachers"><span class="teacher ${lesson.isReplacement ? 'replacement' : 'absent'}">${escapeHtml(lesson.substitutionNote)}</span></div>`;
    }
    const rooms = lesson.secondary
      ? lesson.secondary.split(' / ').map((part) => `<span class="room">${escapeHtml(part)}</span>`).join('')
      : '<span class="room empty">—</span>';
    return `<article class="lesson${empty ? ' empty-lesson' : ''}"><div class="number">${lesson.number}</div><div class="subject">${subject}${teachers}</div><div class="rooms">${rooms}</div></article>`;
  }).join('');
}
function render() {
  const name = state.selected[state.view];
  const days = activeDays();
  const schedule = state.datasets[state.view].get(name) || new Map();
  if (state.selectedDay === ALL_DAYS) {
    const total = days.reduce((sum, day) => sum + (schedule.get(day) || []).filter((lesson) => lesson.primary || lesson.secondary).length, 0);
    $('heading').textContent = `${name} · Вся неделя`;
    $('lessonCount').textContent = total ? `${total} ${plural(total, 'урок', 'урока', 'уроков')} за неделю` : '';
    $('schedule').classList.add('week-view');
    $('schedule').style.setProperty('--week-days', days.length);
    $('schedule').innerHTML = days.map((day) => `<section class="week-day"><h2>${escapeHtml(day)}</h2>${renderLessons(prepareLessons(schedule.get(day) || []))}</section>`).join('');
    return;
  }
  $('schedule').classList.remove('week-view');
  $('schedule').style.removeProperty('--week-days');
  const lessons = prepareLessons(schedule.get(state.selectedDay) || []);
  const lessonTotal = lessons.filter((lesson) => lesson.primary || lesson.secondary).length;
  $('heading').textContent = `${name} · ${state.selectedDay}`;
  $('lessonCount').textContent = lessonTotal ? `${lessonTotal} ${plural(lessonTotal, 'урок', 'урока', 'уроков')}` : '';
  $('schedule').innerHTML = lessons.length ? renderLessons(lessons) : '<div class="empty-day">На этот день занятий нет</div>';
}
function plural(n, one, few, many) { const a=n%10,b=n%100; return a===1&&b!==11?one:a>=2&&a<=4&&(b<12||b>14)?few:many; }
function formatShortDate(value) { const [year, month, day] = value.split('-'); return `${day}.${month}`; }
function escapeHtml(value) { return String(value).replace(/[&<>"]/g,(ch)=>({ '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;' })[ch]); }

$('classSelect').addEventListener('change',(e)=>{state.selected[state.view]=e.target.value;localStorage.setItem(`schedule-${state.view}`,e.target.value);render();});
$('classSearch').addEventListener('input',(e)=>{populateOptions(e.target.value.trim());render();});
$('views').addEventListener('click',(e)=>{const b=e.target.closest('[data-view]');if(b)switchView(b.dataset.view);});
$('days').addEventListener('click',(e)=>{const b=e.target.closest('[data-day]');if(!b)return;state.selectedDay=b.dataset.day;populateDays();render();});
$('refresh').addEventListener('click',load);

function fillSelect(select, items, selected = '') {
  select.innerHTML = items.map((item) => {
    const value = typeof item === 'string' ? item : item.value;
    const label = typeof item === 'string' ? item : item.label;
    return `<option value="${escapeHtml(value)}">${escapeHtml(label)}</option>`;
  }).join('');
  if (items.some((item) => (typeof item === 'string' ? item : item.value) === selected)) select.value = selected;
  select.disabled = !items.length;
}
function selectedClassLesson() {
  const number = Number($('subLesson').value);
  return state.datasets.classes.get($('subClass').value)?.get($('subDay').value)?.find((lesson) => lesson.number === number);
}
function teachersForClass(className) {
  const result = new Set();
  for (const lessons of state.datasets.classes.get(className)?.values() || []) {
    for (const lesson of lessons) for (const teacher of lesson.teachers || []) result.add(teacher);
  }
  return [...result].sort(naturalRu);
}
function subjectKeys(value) {
  return value.split(' / ').map((part) => part.toLocaleLowerCase('ru').replace(/\s+/g, ' ').trim()).filter(Boolean);
}
function teachersForSubject(subject) {
  const targets = new Set(subjectKeys(subject));
  const result = new Set();
  for (const days of state.datasets.classes.values()) {
    for (const lessons of days.values()) {
      for (const lesson of lessons) {
        if (!subjectKeys(lesson.primary || '').some((part) => targets.has(part))) continue;
        for (const teacher of lesson.teachers || []) result.add(teacher);
      }
    }
  }
  return [...result].sort(naturalRu);
}
function teacherIsBusy(teacher, day, number) {
  const lesson = state.datasets.teachers.get(teacher)?.get(day)?.find((item) => item.number === number);
  return Boolean(lesson?.primary || lesson?.secondary);
}
function currentSubstitution() {
  return state.substitutions.find((item) => item.className === $('subClass').value && item.day === $('subDay').value && Number(item.lesson) === Number($('subLesson').value));
}
function renderSubstitutionResult() {
  const lesson = selectedClassLesson();
  if (!lesson) {
    $('substitutionResult').innerHTML = '<div class="result-empty">В этот день у класса нет уроков.</div>';
    return;
  }
  const absent = $('subTeacher').value;
  const existing = currentSubstitution();
  const available = (teacher) => teacher !== absent && (!teacherIsBusy(teacher, $('subDay').value, lesson.number) || teacher === existing?.replacementTeacher);
  const classCandidates = teachersForClass($('subClass').value).filter(available);
  const classSet = new Set(classCandidates);
  const subjectTeachers = teachersForSubject(lesson.primary || '');
  const subjectSet = new Set(subjectTeachers);
  const subjectCandidates = subjectTeachers.filter(available).filter((teacher) => !classSet.has(teacher));
  const candidates = [...classCandidates, ...subjectCandidates];
  const options = candidates.map((teacher) => ({
    value: teacher,
    label: `${teacher} — ${classSet.has(teacher) ? (subjectSet.has(teacher) ? 'класс и предмет' : 'работает с классом') : 'ведёт предмет'}`
  }));
  fillSelect($('subReplacement'), options, existing?.replacementTeacher || candidates[0] || '');
  $('removeSubstitution').hidden = !existing;
  const current = lesson.teachers?.length ? lesson.teachers.join(', ') : 'не определён';
  const assigned = existing ? `<br><strong>Назначенная замена: ${escapeHtml(existing.replacementTeacher)}</strong>` : '';
  const summary = `<div class="result-summary"><strong>${escapeHtml(lesson.number)} урок: ${escapeHtml(lesson.primary || 'Без названия')}</strong><br>Кабинет: ${escapeHtml(lesson.secondary || 'не указан')} · По расписанию: ${escapeHtml(current)}${assigned}</div>`;
  const classResult = classCandidates.length
    ? `<p class="result-title">Свободны и работают с классом: ${classCandidates.length}</p><div class="result-list">${classCandidates.map((teacher) => `<span class="result-chip">${escapeHtml(teacher)}</span>`).join('')}</div>`
    : '<p class="result-empty">Свободных учителей этого класса не найдено.</p>';
  const subjectResult = subjectCandidates.length
    ? `<p class="result-title result-section">Другие свободные учителя предмета «${escapeHtml(lesson.primary)}»: ${subjectCandidates.length}</p><div class="result-list">${subjectCandidates.map((teacher) => `<span class="result-chip subject-chip">${escapeHtml(teacher)}</span>`).join('')}</div>`
    : `<p class="result-empty result-section">Других свободных учителей предмета «${escapeHtml(lesson.primary || 'урок')}» не найдено.</p>`;
  const result = classResult + subjectResult;
  $('substitutionResult').innerHTML = summary + result;
}
function populateAbsentTeachers() {
  const lesson = selectedClassLesson();
  const existing = currentSubstitution();
  const teachers = [...(lesson?.teachers || [])];
  if (existing?.absentTeacher && !teachers.includes(existing.absentTeacher)) teachers.push(existing.absentTeacher);
  fillSelect($('subTeacher'), teachers.length ? teachers : [{ value: '', label: 'Не определён' }], existing?.absentTeacher || teachers[0] || '');
  renderSubstitutionResult();
}
function populateSubstitutionLessons() {
  const lessons = [...(state.datasets.classes.get($('subClass').value)?.get($('subDay').value) || [])]
    .filter((lesson) => lesson.primary || lesson.secondary).sort((a,b) => a.number-b.number);
  fillSelect($('subLesson'), lessons.map((lesson) => ({ value: String(lesson.number), label: `${lesson.number} — ${lesson.primary || 'урок'}` })));
  populateAbsentTeachers();
}
let absencePlan = [];
function dateInputValue(date) {
  const local = new Date(date.getTime() - date.getTimezoneOffset() * 60000);
  return local.toISOString().slice(0, 10);
}
function weekdayName(date) {
  const value = new Intl.DateTimeFormat('ru-RU', { weekday: 'long' }).format(date);
  return value.charAt(0).toLocaleUpperCase('ru') + value.slice(1);
}
function daysInsidePeriod(from, to) {
  const result = new Set();
  const cursor = new Date(`${from}T12:00:00`);
  const finish = new Date(`${to}T12:00:00`);
  while (cursor <= finish) {
    result.add(weekdayName(cursor));
    cursor.setDate(cursor.getDate() + 1);
  }
  return result;
}
function renderAbsencePlan(message = '') {
  if (!absencePlan.length) {
    $('absencePlanResult').innerHTML = `<div class="result-empty">${escapeHtml(message || 'Для выбранного периода уроки не найдены.')}</div>`;
    $('saveAbsencePlan').disabled = true;
    return;
  }
  const unresolved = absencePlan.filter((item) => !item.replacement).length;
  const rows = absencePlan.map((item, index) => {
    const options = item.candidates.length
      ? item.candidates.map((candidate) => `<option value="${escapeHtml(candidate.name)}"${candidate.name === item.replacement ? ' selected' : ''}>${escapeHtml(candidate.name)} — ${escapeHtml(candidate.reason)}</option>`).join('')
      : '<option value="">Нет свободного предметника</option>';
    return `<div class="plan-row"><span class="plan-date">${escapeHtml(item.day)}</span><span class="plan-lesson">${item.lesson}</span><span class="plan-info"><strong>${escapeHtml(item.classNames.join(', '))}</strong><br>${escapeHtml(item.subjects.join(' / ') || 'Предмет не определён')}</span><select data-plan-index="${index}"${item.candidates.length ? '' : ' disabled'}>${options}</select></div>`;
  }).join('');
  $('absencePlanResult').innerHTML = `<p class="result-title">План замен: ${absencePlan.length}${unresolved ? ` · <span class="plan-warning">без кандидата: ${unresolved}</span>` : ''}</p><div class="plan-list">${rows}</div>`;
  $('saveAbsencePlan').disabled = unresolved > 0;
}
function buildAbsencePlan() {
  const absent = $('absenceTeacher').value;
  const from = $('absenceFrom').value;
  const to = $('absenceTo').value;
  if (!absent || !from || !to || to < from) {
    absencePlan = [];
    renderAbsencePlan('Проверьте учителя и даты отсутствия.');
    return;
  }
  const start = new Date(`${from}T12:00:00`);
  const finish = new Date(`${to}T12:00:00`);
  if ((finish - start) / 86400000 > 62) {
    absencePlan = [];
    renderAbsencePlan('Период не должен превышать 63 дня.');
    return;
  }
  const includedDays = daysInsidePeriod(from, to);
  const teacherDays = state.datasets.teachers.get(absent) || new Map();
  const load = new Map();
  absencePlan = [];
  for (const day of activeDays('teachers')) {
    if (!includedDays.has(day)) continue;
    const lessons = [...(teacherDays.get(day) || [])].filter((lesson) => lesson.primary || lesson.secondary).sort((a,b) => a.number-b.number);
    for (const lesson of lessons) {
      const classNames = lesson.primary.split(/\s*(?:,|\/|;)\s*/).filter((name) => state.datasets.classes.has(name));
      if (!classNames.length) continue;
      const classLessons = classNames.map((className) => state.datasets.classes.get(className)?.get(day)?.find((item) => item.number === lesson.number)).filter(Boolean);
      const subjects = [...new Set(classLessons.flatMap((item) => item.primary.split(' / ').map((subject) => subject.trim()).filter(Boolean)))];
      const subjectSet = new Set(subjects.flatMap(teachersForSubject));
      subjectSet.delete(absent);
      const classSet = new Set(classNames.flatMap(teachersForClass));
      classSet.delete(absent);
      const available = (teacher) => !teacherIsBusy(teacher, day, lesson.number);
      const subjectCandidates = [...subjectSet].filter(available).sort(naturalRu);
      const classCandidates = [...classSet].filter(available).filter((teacher) => !subjectSet.has(teacher)).sort(naturalRu);
      const candidates = [...subjectCandidates.map((name) => ({ name, reason: classSet.has(name) ? 'предмет и класс' : 'тот же предмет' })), ...classCandidates.map((name) => ({ name, reason: 'работает с классом' }))];
      candidates.sort((a, b) => (load.get(a.name) || 0) - (load.get(b.name) || 0) || naturalRu(a.name, b.name));
      const replacement = candidates[0]?.name || '';
      if (replacement) load.set(replacement, (load.get(replacement) || 0) + 1);
      absencePlan.push({ day, lesson: lesson.number, classNames, subjects, candidates, replacement });
    }
  }
  renderAbsencePlan();
}
async function saveAbsencePlan() {
  const password = $('absencePassword').value;
  if (!password) { renderAbsencePlan(); $('absencePlanResult').insertAdjacentHTML('afterbegin', '<div class="upload-status error">Введите пароль изменения.</div>'); return; }
  if (!absencePlan.length || absencePlan.some((item) => !item.replacement)) return;
  $('saveAbsencePlan').disabled = true;
  const plan = absencePlan.flatMap((item) => item.classNames.map((className) => ({ className, day: item.day, lesson: item.lesson, replacementTeacher: item.replacement })));
  try {
    const response = await fetch('/api/schedule-upload/substitutions', {
      method: 'POST',
      headers: { Authorization: `Bearer ${password}`, 'Content-Type': 'application/json; charset=utf-8' },
      body: JSON.stringify({ action: 'set-period', absentTeacher: $('absenceTeacher').value, dateFrom: $('absenceFrom').value, dateTo: $('absenceTo').value, plan })
    });
    const result = await response.json();
    if (!response.ok) throw new Error(result.error || 'Не удалось сохранить план замен');
    await load();
    renderAbsencePlan();
    $('absencePlanResult').insertAdjacentHTML('afterbegin', `<div class="upload-status success">${escapeHtml(result.message)}</div>`);
  } catch (error) {
    renderAbsencePlan();
    $('absencePlanResult').insertAdjacentHTML('afterbegin', `<div class="upload-status error">${escapeHtml(error.message)}</div>`);
  } finally {
    $('saveAbsencePlan').disabled = absencePlan.some((item) => !item.replacement);
  }
}
function openSubstitutionDialog() {
  const classes = [...state.datasets.classes.keys()].sort(naturalRu);
  if (!classes.length) return;
  const selectedClass = state.view === 'classes' && classes.includes(state.selected.classes) ? state.selected.classes : classes[0];
  fillSelect($('subClass'), classes, selectedClass);
  const days = activeDays('classes');
  const selectedDay = state.selectedDay !== ALL_DAYS && days.includes(state.selectedDay) ? state.selectedDay : defaultDay(days);
  fillSelect($('subDay'), days, selectedDay);
  const teachers = [...state.datasets.teachers.keys()].sort(naturalRu);
  const selectedTeacher = state.view === 'teachers' && teachers.includes(state.selected.teachers) ? state.selected.teachers : teachers[0];
  fillSelect($('absenceTeacher'), teachers, selectedTeacher);
  const today = new Date();
  const nextWeek = new Date(today); nextWeek.setDate(nextWeek.getDate() + 7);
  $('absenceFrom').value = dateInputValue(today);
  $('absenceTo').value = dateInputValue(nextWeek);
  $('absencePassword').value = '';
  absencePlan = [];
  renderAbsencePlan('Укажите период и запустите автоматический подбор.');
  $('subPassword').value = '';
  populateSubstitutionLessons();
  $('substitutionDialog').showModal();
}
async function changeSubstitution(action) {
  const lesson = selectedClassLesson();
  const password = $('subPassword').value;
  if (!lesson || !password) {
    $('substitutionResult').insertAdjacentHTML('beforeend', '<div class="upload-status error">Введите пароль изменения.</div>');
    return;
  }
  const button = action === 'remove' ? $('removeSubstitution') : $('saveSubstitution');
  button.disabled = true;
  try {
    const response = await fetch('/api/schedule-upload/substitutions', {
      method: 'POST',
      headers: { Authorization: `Bearer ${password}`, 'Content-Type': 'application/json; charset=utf-8' },
      body: JSON.stringify({
        action,
        className: $('subClass').value,
        day: $('subDay').value,
        lesson: lesson.number,
        absentTeacher: $('subTeacher').value,
        replacementTeacher: $('subReplacement').value
      })
    });
    const result = await response.json();
    if (!response.ok) throw new Error(result.error || 'Не удалось изменить замену');
    await load();
    $('subPassword').value = password;
    populateSubstitutionLessons();
    $('substitutionResult').insertAdjacentHTML('afterbegin', `<div class="upload-status success">${escapeHtml(result.message)}</div>`);
  } catch (error) {
    $('substitutionResult').insertAdjacentHTML('afterbegin', `<div class="upload-status error">${escapeHtml(error.message)}</div>`);
  } finally {
    button.disabled = false;
  }
}

function populateFreeRoomLessons() {
  const day = $('freeRoomDay').value;
  const numbers = [...new Set([...state.datasets.rooms.values()].flatMap((days) => (days.get(day) || []).map((lesson) => lesson.number)))].sort((a,b) => a-b);
  fillSelect($('freeRoomLesson'), numbers.map((number) => ({ value: String(number), label: `${number} урок` })));
  renderFreeRooms();
}
function renderFreeRooms() {
  const day = $('freeRoomDay').value;
  const number = Number($('freeRoomLesson').value);
  if (!day || !number) {
    $('freeRoomsResult').innerHTML = '<div class="result-empty">Нет данных для выбранного времени.</div>';
    return;
  }
  const rooms = [...state.datasets.rooms.keys()].sort(naturalRu).filter((room) => {
    const lesson = state.datasets.rooms.get(room)?.get(day)?.find((item) => item.number === number);
    return !lesson?.primary && !lesson?.secondary;
  });
  $('freeRoomsResult').innerHTML = rooms.length
    ? `<p class="result-title">Свободно кабинетов: ${rooms.length}</p><div class="result-list">${rooms.map((room) => `<span class="result-chip">${escapeHtml(room)}</span>`).join('')}</div>`
    : '<div class="result-empty">Свободных кабинетов на этот урок не найдено.</div>';
}
function openFreeRoomsDialog() {
  const days = activeDays('rooms');
  const selectedDay = state.selectedDay !== ALL_DAYS && days.includes(state.selectedDay) ? state.selectedDay : defaultDay(days);
  fillSelect($('freeRoomDay'), days, selectedDay);
  populateFreeRoomLessons();
  $('freeRoomsDialog').showModal();
}

$('openSubstitution').addEventListener('click', openSubstitutionDialog);
$('autoPlanSubstitutions').addEventListener('click', buildAbsencePlan);
$('saveAbsencePlan').addEventListener('click', saveAbsencePlan);
$('absencePlanResult').addEventListener('change', (event) => {
  const select = event.target.closest('[data-plan-index]');
  if (!select) return;
  absencePlan[Number(select.dataset.planIndex)].replacement = select.value;
  $('saveAbsencePlan').disabled = absencePlan.some((item) => !item.replacement);
});
$('subClass').addEventListener('change', populateSubstitutionLessons);
$('subDay').addEventListener('change', populateSubstitutionLessons);
$('subLesson').addEventListener('change', populateAbsentTeachers);
$('subTeacher').addEventListener('change', renderSubstitutionResult);
$('saveSubstitution').addEventListener('click', () => changeSubstitution('set'));
$('removeSubstitution').addEventListener('click', () => changeSubstitution('remove'));
$('closeSubstitution').addEventListener('click', () => $('substitutionDialog').close());
$('cancelSubstitution').addEventListener('click', () => $('substitutionDialog').close());
$('openFreeRooms').addEventListener('click', openFreeRoomsDialog);
$('freeRoomDay').addEventListener('change', populateFreeRoomLessons);
$('freeRoomLesson').addEventListener('change', renderFreeRooms);
$('closeFreeRooms').addEventListener('click', () => $('freeRoomsDialog').close());
$('cancelFreeRooms').addEventListener('click', () => $('freeRoomsDialog').close());

const uploadDialog = $('uploadDialog');
const uploadForm = $('uploadForm');
const uploadStatus = $('uploadStatus');
const submitUpload = $('submitUpload');

function showUploadStatus(message, type = '') {
  uploadStatus.textContent = message;
  uploadStatus.className = `upload-status${type ? ` ${type}` : ''}`;
  uploadStatus.hidden = false;
}
function closeUploadDialog() {
  uploadDialog.close();
}
function toBase64(buffer) {
  const bytes = new Uint8Array(buffer);
  let binary = '';
  for (let offset = 0; offset < bytes.length; offset += 32768) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + 32768));
  }
  return btoa(binary);
}
async function collectHtmlFiles(inputId, title) {
  const files = [...$(inputId).files];
  if (!files.length) throw new Error(`Выберите HTML-файлы раздела «${title}»`);
  const names = files.map((file) => file.name.toLocaleLowerCase('ru'));
  if (names.some((name) => !/^index(?:\d+)?\.html?$/i.test(name))) {
    throw new Error(`В разделе «${title}» можно выбирать только файлы index*.html`);
  }
  if (new Set(names).size !== names.length) throw new Error(`В разделе «${title}» есть повторяющиеся имена файлов`);
  if (!names.includes('index.html')) throw new Error(`В разделе «${title}» не выбран главный файл index.html`);
  const mainFile = files[names.indexOf('index.html')];
  const indexText = new TextDecoder('windows-1251').decode(await mainFile.arrayBuffer());
  const referenced = [...indexText.matchAll(/index\d+\.html?/gi)].map((match) => match[0].toLocaleLowerCase('ru'));
  const missing = [...new Set(referenced)].filter((name) => !names.includes(name));
  if (missing.length) throw new Error(`Для раздела «${title}» не выбраны: ${missing.join(', ')}`);
  return Promise.all(files.map(async (file) => ({ name: file.name, content: toBase64(await file.arrayBuffer()) })));
}

$('openUpload').addEventListener('click', () => {
  uploadForm.reset();
  uploadStatus.hidden = true;
  submitUpload.disabled = false;
  submitUpload.textContent = 'Загрузить';
  uploadDialog.showModal();
});
$('closeUpload').addEventListener('click', closeUploadDialog);
$('cancelUpload').addEventListener('click', closeUploadDialog);
uploadForm.addEventListener('submit', async (event) => {
  event.preventDefault();
  const password = $('uploadPassword').value;
  if (!password) return;
  submitUpload.disabled = true;
  submitUpload.textContent = 'Подготовка…';
  showUploadStatus('Проверка выбранных HTML-файлов…');
  try {
    const datasets = {
      classes: await collectHtmlFiles('classesFiles', 'Классы'),
      teachers: await collectHtmlFiles('teachersFiles', 'Учителя'),
      rooms: await collectHtmlFiles('roomsFiles', 'Кабинеты')
    };
    submitUpload.textContent = 'Публикация…';
    showUploadStatus('Передача полного комплекта на сервер…');
    const response = await fetch('/api/schedule-upload/upload-html', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${password}`,
        'Content-Type': 'application/json; charset=utf-8'
      },
      body: JSON.stringify({ datasets })
    });
    const result = await response.json();
    if (!response.ok) throw new Error(result.error || 'Не удалось загрузить файл');
    showUploadStatus(`${result.message} Загружено файлов: ${result.files}.`, 'success');
    submitUpload.disabled = false;
    submitUpload.textContent = 'Загрузить ещё раз';
    await load();
  } catch (error) {
    showUploadStatus(error.message, 'error');
    submitUpload.disabled = false;
    submitUpload.textContent = 'Повторить';
  }
});
load();
