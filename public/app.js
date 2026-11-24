const { PDFDocument } = window.PDFLib;
const $ = (id) => document.getElementById(id);

let selectedFile = null;
let results = [];

$('dropZone').onclick = () => $('fileInput').click();
$('dropZone').ondragover = (e) => { e.preventDefault(); $('dropZone').classList.add('border-blue-500', 'bg-blue-50'); };
$('dropZone').ondragleave = () => $('dropZone').classList.remove('border-blue-500', 'bg-blue-50');
$('dropZone').ondrop = (e) => {
  e.preventDefault();
  $('dropZone').classList.remove('border-blue-500', 'bg-blue-50');
  if (e.dataTransfer.files[0]) setFile(e.dataTransfer.files[0]);
};
$('fileInput').onchange = (e) => { if (e.target.files[0]) setFile(e.target.files[0]); };

function setFile(file) {
  if (file.type !== 'application/pdf') return alert('PDF 파일만 업로드할 수 있습니다.');
  selectedFile = file;
  $('fileInfo').textContent = `선택된 파일: ${file.name} (${(file.size / 1024 / 1024).toFixed(2)} MB)`;
  $('fileInfo').classList.remove('hidden');
}

function uint8ToBase64(bytes) {
  let binary = '';
  for (let i = 0; i < bytes.byteLength; i++) binary += String.fromCharCode(bytes[i]);
  return btoa(binary);
}

// 대용량 PDF라도 구조 파악용 경량 PDF(최대 30페이지 단위)로 안전하게 변환
async function buildSlicePdfBase64(srcDoc, startPage1Based, endPage1Based) {
  const newDoc = await PDFDocument.create();
  const total = srcDoc.getPageCount();
  const start = Math.max(0, startPage1Based - 1);
  const end = Math.min(total - 1, endPage1Based - 1);
  const indices = [];
  for (let i = start; i <= end; i++) indices.push(i);
  const copied = await newDoc.copyPages(srcDoc, indices);
  copied.forEach((p) => newDoc.addPage(p));
  const bytes = await newDoc.save();
  return uint8ToBase64(bytes);
}

$('startBtn').onclick = async () => {
  if (!selectedFile) return alert('먼저 학생 시험지 PDF를 선택해 주세요.');

  $('startBtn').disabled = true;
  $('progressBox').classList.remove('hidden');
  $('errorText').classList.add('hidden');
  $('studentList').innerHTML = '';
  results = [];

  const info = {
    grade: $('grade').value,
    semester: $('semester').value,
    subject: $('subject').value,
    domain: $('domain').value,
    evalType: $('evalType').value,
    standards: $('standards').value,
    criteria: $('criteria').value
  };

  try {
    updateProgress(10, '1단계: PDF 페이지 구조를 읽고 학생별 시험지 구간을 파악하는 중...');
    const arrayBuffer = await selectedFile.arrayBuffer();
    const srcDoc = await PDFDocument.load(arrayBuffer);
    const totalPages = srcDoc.getPageCount();

    // 15페이지씩 끊어서 학생 구간 탐색 (대용량 페이로드 초과 방지)
    let allStudents = [];
    const chunkPages = 15;
    for (let p = 1; p <= totalPages; p += chunkPages) {
      const endP = Math.min(totalPages, p + chunkPages - 1);
      const sliceBase64 = await buildSlicePdfBase64(srcDoc, p, endP);
      const res = await fetch('/api/analyze', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ mode: 'structure', pdfBase64: sliceBase64 })
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error);

      (data.students || []).forEach((st) => {
        allStudents.push({
          ...st,
          page_start: p + st.page_start - 1,
          page_end: p + st.page_end - 1
        });
      });
    }

    if (allStudents.length === 0) throw new Error('PDF에서 학생 시험지를 구분하지 못했습니다.');

    $('resultSection').classList.remove('hidden');
    const existingDrafts = [];

    // 2단계: 학생 1명씩 해당 페이지만 쪼개서 AI 분석
    for (let i = 0; i < allStudents.length; i++) {
      const st = allStudents[i];
      const pct = 20 + Math.round(((i + 1) / allStudents.length) * 80);
      updateProgress(pct, `2단계: [${st.student_name}] 학생 답안 채점 및 생기부 작성 중... (${i + 1}/${allStudents.length}명)`);

      const studentPdfBase64 = await buildSlicePdfBase64(srcDoc, st.page_start, st.page_end);
      const res = await fetch('/api/analyze', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          mode: 'student',
          pdfBase64: studentPdfBase64,
          info,
          student: st,
          existingDrafts
        })
      });
      const analysis = await res.json();
      if (!res.ok) throw new Error(`${st.student_name} 분석 실패: ${analysis.error}`);

      existingDrafts.push(analysis.record_draft);
      const recordItem = { ...st, ...analysis };
      results.push(recordItem);
      appendStudentCard(recordItem);
      $('summaryText').textContent = `총 ${allStudents.length}명 중 ${results.length}명 분석 완료`;
    }

    updateProgress(100, '모든 학생의 성취도 분석 및 생활기록부 초안 생성이 완료되었습니다!');
  } catch (err) {
    $('errorText').textContent = `오류: ${err.message}`;
    $('errorText').classList.remove('hidden');
  } finally {
    $('startBtn').disabled = false;
  }
};

function updateProgress(pct, text) {
  $('progressBar').style.width = `${pct}%`;
  $('percentText').textContent = `${pct}%`;
  $('statusText').textContent = text;
}

function appendStudentCard(st) {
  const card = document.createElement('div');
  card.className = 'bg-white p-5 rounded-xl border border-slate-200 shadow-sm flex flex-col gap-3';
  const warnBadge = (st.status === 'needs_review' || st.review_needed)
    ? `<span class="text-xs font-bold px-2 py-0.5 rounded-full bg-amber-100 text-amber-800">확인 필요</span>` : '';

  const qDetails = (st.questions || [])
    .map((q) => `• ${q.q_num}번 (${q.score}/${q.max_score}점): 응답 "${q.student_ans}" → ${q.reason}`)
    .join('\n');

  card.innerHTML = `
    <div class="flex justify-between items-center">
      <div class="font-bold text-base text-blue-700">${st.student_number ? st.student_number + '번 ' : ''}${st.student_name} <span class="text-xs font-normal text-slate-400">(${st.page_start}~${st.page_end}p)</span></div>
      <div class="flex gap-1.5 items-center">
        ${warnBadge}
        <span class="text-xs font-bold px-2.5 py-1 rounded-full bg-blue-50 text-blue-700">${st.achievement_level} (${st.total_score}/${st.max_score}점)</span>
      </div>
    </div>
    <div class="text-xs text-slate-600 space-y-1 bg-slate-50 p-3 rounded-lg">
      <div><strong class="text-slate-800">강점:</strong> ${st.strengths}</div>
      <div><strong class="text-slate-800">보완:</strong> ${st.improvements}</div>
    </div>
    <textarea class="draft-box w-full border rounded-lg p-3 text-sm leading-relaxed" rows="4">${st.record_draft}</textarea>
    <details class="text-xs text-slate-500">
      <summary class="cursor-pointer font-medium hover:text-slate-800">문항별 채점 근거 보기</summary>
      <pre class="mt-2 whitespace-pre-wrap bg-slate-50 p-2.5 rounded border text-slate-600">${qDetails}</pre>
    </details>
    <div class="flex justify-end">
      <button class="copy-btn px-3 py-1.5 text-xs font-semibold border rounded-lg hover:bg-slate-100">문장 복사</button>
    </div>
  `;

  card.querySelector('.draft-box').oninput = (e) => { st.record_draft = e.target.value; };
  card.querySelector('.copy-btn').onclick = () => {
    navigator.clipboard.writeText(st.record_draft);
    alert(`${st.student_name} 학생 문장이 복사되었습니다.`);
  };
  $('studentList').appendChild(card);
}

$('copyAllBtn').onclick = () => {
  const text = results.map((r) => `[${r.student_number ? r.student_number + '번 ' : ''}${r.student_name}]\n${r.record_draft}`).join('\n\n');
  navigator.clipboard.writeText(text);
  alert('전체 학생의 생활기록부 문장이 복사되었습니다.');
};

$('excelBtn').onclick = () => {
  const rows = results.map((r) => ({
    '번호': r.student_number || '',
    '이름': r.student_name,
    '총점': `${r.total_score}/${r.max_score}`,
    '성취수준': r.achievement_level,
    '강점': r.strengths,
    '보완점': r.improvements,
    '생활기록부 초안': r.record_draft
  }));
  const ws = XLSX.utils.json_to_sheet(rows);
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, '생활기록부');
  XLSX.writeFile(wb, '학생_성취도_및_생활기록부.xlsx');
};
