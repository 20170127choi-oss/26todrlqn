const { PDFDocument } = window.PDFLib;
const $ = (id) => document.getElementById(id);

let selectedFile = null;
let results = [];

// 1. 업로드 영역 클릭 및 드래그 이벤트 연결
const dropZone = $('dropZone');
const fileInput = $('fileInput');

if (dropZone && fileInput) {
  dropZone.addEventListener('click', () => fileInput.click());
  dropZone.addEventListener('dragover', (e) => {
    e.preventDefault();
    dropZone.classList.add('border-blue-500', 'bg-blue-50');
  });
  dropZone.addEventListener('dragleave', () => {
    dropZone.classList.remove('border-blue-500', 'bg-blue-50');
  });
  dropZone.addEventListener('drop', (e) => {
    e.preventDefault();
    dropZone.classList.remove('border-blue-500', 'bg-blue-50');
    if (e.dataTransfer.files && e.dataTransfer.files[0]) {
      setFile(e.dataTransfer.files[0]);
    }
  });
  fileInput.addEventListener('change', (e) => {
    if (e.target.files && e.target.files[0]) {
      setFile(e.target.files[0]);
    }
  });
}

function setFile(file) {
  if (file.type !== 'application/pdf' && !file.name.toLowerCase().endsWith('.pdf')) {
    alert('PDF 파일만 업로드할 수 있습니다.');
    return;
  }
  selectedFile = file;
  $('fileInfo').textContent = `선택된 파일: ${file.name} (${(file.size / 1024 / 1024).toFixed(2)} MB)`;
  $('fileInfo').classList.remove('hidden');
}

function uint8ToBase64(bytes) {
  let binary = '';
  const chunkSize = 0x8000;
  for (let i = 0; i < bytes.length; i += chunkSize) {
    binary += String.fromCharCode.apply(null, bytes.subarray(i, i + chunkSize));
  }
  return btoa(binary);
}

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

  const sizeMb = bytes.byteLength / (1024 * 1024);
  if (sizeMb > 3.5) {
    throw new Error(`${startPage1Based}~${endPage1Based}페이지 용량(${sizeMb.toFixed(1)}MB)이 3.5MB를 초과합니다. 스캔 해상도를 낮춰 주세요.`);
  }
  return uint8ToBase64(bytes);
}

async function postAnalyze(payload) {
  const res = await fetch('/api/analyze', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload)
  });

  const rawText = await res.text();
  let data;
  try {
    data = JSON.parse(rawText);
  } catch {
    if (res.status === 413) throw new Error('전송 용량 초과(413): 스캔 해상도가 너무 높습니다.');
    if (res.status === 504) throw new Error('서버 응답 시간 초과(504): 다시 시도해 주세요.');
    throw new Error(`서버 오류(${res.status}): ${rawText.slice(0, 120)}`);
  }

  if (!res.ok) {
    throw new Error(data.error || `요청 실패 (${res.status})`);
  }
  return data;
}

$('startBtn').addEventListener('click', async () => {
  if (!selectedFile) {
    alert('먼저 학생 시험지 PDF를 선택해 주세요.');
    return;
  }

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
    updateProgress(5, '1단계: PDF 파일을 불러오는 중...');
    const arrayBuffer = await selectedFile.arrayBuffer();
    const srcDoc = await PDFDocument.load(arrayBuffer);
    const totalPages = srcDoc.getPageCount();

    // 2페이지씩 가볍게 끊어서 학생 구간 탐색 (용량/시간 초과 원천 차단)
    let allStudents = [];
    const chunkPages = 2;
    for (let p = 1; p <= totalPages; p += chunkPages) {
      const endP = Math.min(totalPages, p + chunkPages - 1);
      const scanPct = 5 + Math.round((endP / totalPages) * 20);
      updateProgress(scanPct, `1단계: 학생별 시험지 구간 확인 중... (${endP}/${totalPages}페이지)`);

      const sliceBase64 = await buildSlicePdfBase64(srcDoc, p, endP);
      const data = await postAnalyze({ mode: 'structure', pdfBase64: sliceBase64 });

      (data.students || []).forEach((st) => {
        const realStart = p + st.page_start - 1;
        const realEnd = p + st.page_end - 1;
        const prev = allStudents[allStudents.length - 1];
        if (prev && prev.student_name === st.student_name && st.student_name !== '미확인') {
          prev.page_end = realEnd;
        } else {
          allStudents.push({
            ...st,
            page_start: realStart,
            page_end: realEnd
          });
        }
      });
    }

    if (allStudents.length === 0) {
      throw new Error('PDF에서 학생 시험지를 구분하지 못했습니다.');
    }

    $('resultSection').classList.remove('hidden');
    const existingDrafts = [];

    for (let i = 0; i < allStudents.length; i++) {
      const st = allStudents[i];
      const pct = 25 + Math.round(((i + 1) / allStudents.length) * 75);
      updateProgress(pct, `2단계: [${st.student_name}] 학생 채점 및 생기부 작성 중... (${i + 1}/${allStudents.length}명)`);

      const studentPdfBase64 = await buildSlicePdfBase64(srcDoc, st.page_start, st.page_end);
      const analysis = await postAnalyze({
        mode: 'student',
        pdfBase64: studentPdfBase64,
        info,
        student: st,
        existingDrafts
      });

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
});

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

  card.querySelector('.draft-box').addEventListener('input', (e) => {
    st.record_draft = e.target.value;
  });
  card.querySelector('.copy-btn').addEventListener('click', () => {
    navigator.clipboard.writeText(st.record_draft);
    alert(`${st.student_name} 학생 문장이 복사되었습니다.`);
  });
  $('studentList').appendChild(card);
}

$('copyAllBtn').addEventListener('click', () => {
  const text = results.map((r) => `[${r.student_number ? r.student_number + '번 ' : ''}${r.student_name}]\n${r.record_draft}`).join('\n\n');
  navigator.clipboard.writeText(text);
  alert('전체 학생의 생활기록부 문장이 복사되었습니다.');
});

$('excelBtn').addEventListener('click', () => {
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
});
