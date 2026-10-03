const labels = {
  classes: { select: 'Класс или группа', search: 'Например, 7а', eyebrow: 'РАСПИСАНИЕ КЛАССА' },
  teachers: { select: 'Учитель', search: 'Введите фамилию', eyebrow: 'РАСПИСАНИЕ УЧИТЕЛЯ' },
  rooms: { select: 'Кабинет', search: 'Например, 212', eyebrow: 'РАСПИСАНИЕ КАБИНЕТА' }
};
const state = { datasets: { classes: new Map(), teachers: new Map(), rooms: new Map() }, view: 'classes', selected: {}, selectedDay: '' };
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
async function load() {
  Object.values(state.datasets).forEach((data) => data.clear());
  $('notice').hidden = true; $('schedule').innerHTML = '<div class="skeleton"></div><div class="skeleton"></div><div class="skeleton"></div>';
  try {
    await loadVersion();
    await Promise.all([loadDataset('classes', parseClasses), loadDataset('teachers', parseTeachers), loadDataset('rooms', parseRooms)]);
    addTeachersToClasses();
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
function activeDays() {
  const all = [...state.datasets[state.view].values()].flatMap((days) => [...days.keys()]);
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
    const teachers = state.view === 'classes' && lesson.teachers?.length
      ? `<div class="teachers" aria-label="Учителя">${lesson.teachers.map((teacher) => `<span class="teacher">${escapeHtml(teacher)}</span>`).join('')}</div>`
      : '';
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
function escapeHtml(value) { return String(value).replace(/[&<>"]/g,(ch)=>({ '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;' })[ch]); }

$('classSelect').addEventListener('change',(e)=>{state.selected[state.view]=e.target.value;localStorage.setItem(`schedule-${state.view}`,e.target.value);render();});
$('classSearch').addEventListener('input',(e)=>{populateOptions(e.target.value.trim());render();});
$('views').addEventListener('click',(e)=>{const b=e.target.closest('[data-view]');if(b)switchView(b.dataset.view);});
$('days').addEventListener('click',(e)=>{const b=e.target.closest('[data-day]');if(!b)return;state.selectedDay=b.dataset.day;populateDays();render();});
$('refresh').addEventListener('click',load);

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
