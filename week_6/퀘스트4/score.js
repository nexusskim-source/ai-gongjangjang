// 📸 Day On 인스타 인플루언서 후보 채점
// 실행: node score.js
// 입력: 인플루언서_후보.csv   출력: 인플루언서_평가결과.csv (+ 콘솔 순위표)
//
// 사람이 채우는 것 : 팔로워수 / 좋아요·댓글 9개 / 지역적합도 / 콘텐츠결
// 스크립트가 계산   : 평균 좋아요·댓글 / 인게이지먼트율 / 점수 / 순위 / 위험신호

const fs = require('fs');
const path = require('path');

const IN = path.join(__dirname, '인플루언서_후보.csv');
const OUT = path.join(__dirname, '인플루언서_평가결과.csv');

// ── 점수 기준 (평가틀.md 3장) ──
const 지역점수 = { '도보권': 25, '인접': 15, '같은시구': 8, '무관': 0 };
const 콘텐츠점수 = { '디저트': 20, '공간': 20, '로컬': 20, '일반카페': 12, '무관': 4 };

function erScore(er) {
  if (er >= 6) return 40;
  if (er >= 4) return 32;
  if (er >= 3) return 24;
  if (er >= 2) return 12;
  return 0;
}

function followerScore(f) {
  if (f >= 5000 && f <= 50000) return 15;   // 마이크로 = 핵심 구간
  if (f >= 1000 && f < 5000) return 8;      // 나노
  if (f > 50000 && f <= 100000) return 8;   // 광역
  return 3;                                  // 10만↑ 또는 1천 미만
}

function parseCsv(text) {
  const lines = text.replace(/^﻿/, '').trim().split(/\r?\n/);
  const cols = lines[0].split(',');
  return lines.slice(1).map((line) => {
    // 따옴표로 감싼 필드 지원
    const cells = [];
    let cur = '', q = false;
    for (const ch of line) {
      if (ch === '"') q = !q;
      else if (ch === ',' && !q) { cells.push(cur); cur = ''; }
      else cur += ch;
    }
    cells.push(cur);
    return Object.fromEntries(cols.map((c, i) => [c.trim(), (cells[i] ?? '').trim()]));
  });
}

const num = (v) => {
  const n = Number(String(v).replace(/[,\s]/g, ''));
  return Number.isFinite(n) ? n : 0;
};
const avg = (a) => (a.length ? a.reduce((x, y) => x + y, 0) / a.length : 0);

const rows = parseCsv(fs.readFileSync(IN, 'utf8'))
  .filter((r) => r.계정핸들 && !r.계정핸들.includes('예시'));

if (rows.length === 0) {
  console.log('⚠️  인플루언서_후보.csv 에 실제 계정이 없습니다.');
  console.log('   예시 행을 지우고 계정을 채운 뒤 다시 실행하세요.');
  process.exit(0);
}

const results = rows.map((r) => {
  const likes = Array.from({ length: 9 }, (_, i) => num(r[`좋아요_${i + 1}`])).filter((v) => v > 0);
  const cmts = Array.from({ length: 9 }, (_, i) => num(r[`댓글_${i + 1}`])).filter((v) => v > 0);
  const followers = num(r.팔로워수);

  const avgLike = Math.round(avg(likes));
  const avgCmt = Math.round(avg(cmts) * 10) / 10;
  const er = followers > 0 ? ((avgLike + avgCmt) / followers) * 100 : 0;

  const sER = erScore(er);
  const sRegion = 지역점수[r.지역적합도] ?? 0;
  const sContent = 콘텐츠점수[r.콘텐츠결] ?? 4;
  const sFollow = followerScore(followers);
  const total = sER + sRegion + sContent + sFollow;

  // 🚩 위험 신호
  const flags = [];
  if (followers >= 10000 && er < 1) flags.push('팔로워 구매 의심(ER<1%)');
  if (followers > 100000) flags.push('전국구 — 도보권 밖 유입');
  if (likes.length < 9 || cmts.length < 9) flags.push(`데이터 부족(게시물 ${Math.min(likes.length, cmts.length)}개)`);
  if (avgCmt > 0 && avgLike / avgCmt > 200) flags.push('댓글 극단적 적음');

  const grade = total >= 80 ? '1순위' : total >= 60 ? '2순위' : '보류';

  return {
    계정핸들: r.계정핸들,
    계정명: r.계정명,
    콘텐츠결: r.콘텐츠결,
    활동지역: r.활동지역,
    팔로워수: followers,
    평균좋아요: avgLike,
    평균댓글: avgCmt,
    '인게이지먼트율(%)': Math.round(er * 100) / 100,
    'ER점수(40)': sER,
    '지역점수(25)': sRegion,
    '콘텐츠점수(20)': sContent,
    '팔로워점수(15)': sFollow,
    총점: total,
    판정: grade,
    위험신호: flags.join(' / '),
    타겟적합도: r.메모 || '',
  };
}).sort((a, b) => b.총점 - a.총점);

results.forEach((r, i) => { r.순위 = i + 1; });

// 콘솔 순위표
console.table(results.map((r) => ({
  순위: r.순위, 계정: r.계정핸들, 팔로워: r.팔로워수.toLocaleString(),
  '평균♥': r.평균좋아요, '평균💬': r.평균댓글,
  'ER%': r['인게이지먼트율(%)'], 총점: r.총점, 판정: r.판정,
  위험신호: r.위험신호 || '-',
})));

// CSV 저장 (엑셀 한글 대응 BOM)
const cols = ['순위', ...Object.keys(results[0]).filter((c) => c !== '순위')];
const esc = (v) => (/[",\n]/.test(String(v)) ? `"${String(v).replace(/"/g, '""')}"` : String(v));
const csv = [cols.join(','), ...results.map((r) => cols.map((c) => esc(r[c] ?? '')).join(','))].join('\r\n');
fs.writeFileSync(OUT, '﻿' + csv, 'utf8');

const top = results.filter((r) => r.총점 >= 80).length;
console.log(`\n✅ ${results.length}개 계정 평가 완료 → 인플루언서_평가결과.csv`);
console.log(`   1순위(80점↑) ${top}개 / 2순위 ${results.filter((r) => r.총점 >= 60 && r.총점 < 80).length}개`);
