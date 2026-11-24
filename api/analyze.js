import { GoogleGenAI, Type } from '@google/genai';

function safeParseJson(text) {
  if (!text) throw new Error('AI가 빈 응답을 반환했습니다.');
  const cleaned = text.replace(/^```json\s*/i, '').replace(/```\s*$/i, '').trim();
  return JSON.parse(cleaned);
}

async function generateWithFallback(ai, baseParams) {
  const primary = process.env.GEMINI_MODEL || 'gemini-3.8-flash-lite';
  const modelsToTry = Array.from(new Set([primary, 'gemini-3.8-flash-lite', 'gemini-3.8-flash']));

  let lastError = null;

  for (const modelName of modelsToTry) {
    for (let attempt = 1; attempt <= 2; attempt++) {
      try {
        return await ai.models.generateContent({
          ...baseParams,
          model: modelName
        });
      } catch (err) {
        lastError = err;
        const msg = err?.message || '';
        const isTemporary =
          msg.includes('503') ||
          msg.includes('429') ||
          msg.includes('UNAVAILABLE') ||
          msg.includes('high demand') ||
          msg.includes('404');

        if (!isTemporary) throw err;
        await new Promise((resolve) => setTimeout(resolve, 1000 * attempt));
      }
    }
  }
  throw lastError;
}

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'POST만 지원합니다.' });

  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) return res.status(500).json({ error: 'Vercel 환경변수에 GEMINI_API_KEY를 설정해 주세요.' });

  try {
    const { mode, pdfBase64, info, student, existingDrafts } = req.body;
    const ai = new GoogleGenAI({ apiKey });

    if (mode === 'structure') {
      const response = await generateWithFallback(ai, {
        contents: [
          { inlineData: { data: pdfBase64, mimeType: 'application/pdf' } },
          `초등학교 평가 PDF입니다. 각 학생의 시험지가 몇 페이지부터 몇 페이지까지인지 구분하세요.
          이름이 흐리거나 안 보이면 student_name을 "미확인", status를 "needs_review"로 표시하세요.`
        ],
        config: {
          responseMimeType: 'application/json',
          responseSchema: {
            type: Type.OBJECT,
            properties: {
              students: {
                type: Type.ARRAY,
                items: {
                  type: Type.OBJECT,
                  properties: {
                    student_number: { type: Type.STRING },
                    student_name: { type: Type.STRING },
                    page_start: { type: Type.INTEGER },
                    page_end: { type: Type.INTEGER },
                    status: { type: Type.STRING }
                  },
                  required: ['student_name', 'page_start', 'page_end', 'status']
                }
              }
            },
            required: ['students']
          }
        }
      });
      return res.status(200).json(safeParseJson(response.text));
    }

    if (mode === 'student') {
      const prompt = `당신은 초등학교 교육과정 및 평가 분석 전문가입니다.
제공된 시험지 PDF는 [${student.student_number || ''} ${student.student_name}] 학생의 답안지입니다.

[평가 정보]
- 학년/학기: ${info.grade} ${info.semester}
- 과목/영역: ${info.subject} - ${info.domain} (${info.evalType})
- 성취기준: ${info.standards || '시험지 문항 내용 기반 핵심 평가 요소 추출'}
- 평가기준: ${info.criteria}

[작성 원칙]
1. 시험지에 실제로 적힌 답안만 근거로 채점하고, 손글씨가 불명확하면 review_needed를 true로 표시하세요.
2. 점수, 등수, 시험지에 없는 인성/태도는 절대 생기부 문장에 쓰지 마세요.
3. 나이스 기재 요령에 맞춰 명사형 종결 어미(~함., ~임., ~보임.)로 긍정적·발전적으로 작성하세요.
4. 다른 학생 문장과 표현이 겹치지 않게 작성하세요.
${existingDrafts?.length ? `[중복 회피 참고 문장]\n- ${existingDrafts.slice(-5).join('\n- ')}` : ''}`;

      const response = await generateWithFallback(ai, {
        contents: [
          { inlineData: { data: pdfBase64, mimeType: 'application/pdf' } },
          prompt
        ],
        config: {
          responseMimeType: 'application/json',
          responseSchema: {
            type: Type.OBJECT,
            properties: {
              total_score: { type: Type.NUMBER },
              max_score: { type: Type.NUMBER },
              achievement_level: { type: Type.STRING },
              strengths: { type: Type.STRING },
              improvements: { type: Type.STRING },
              record_draft: { type: Type.STRING },
              review_needed: { type: Type.BOOLEAN },
              questions: {
                type: Type.ARRAY,
                items: {
                  type: Type.OBJECT,
                  properties: {
                    q_num: { type: Type.STRING },
                    student_ans: { type: Type.STRING },
                    correct_ans: { type: Type.STRING },
                    score: { type: Type.NUMBER },
                    max_score: { type: Type.NUMBER },
                    reason: { type: Type.STRING }
                  },
                  required: ['q_num', 'student_ans', 'score', 'max_score', 'reason']
                }
              }
            },
            required: ['total_score', 'max_score', 'achievement_level', 'strengths', 'improvements', 'record_draft', 'review_needed', 'questions']
          }
        }
      });
      return res.status(200).json(safeParseJson(response.text));
    }

    return res.status(400).json({ error: '잘못된 요청 모드입니다.' });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
}
