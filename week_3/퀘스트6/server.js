/*
 * 날씨 기반 옷차림 추천 서버 (Express + Open-Meteo)
 * ------------------------------------------------------------
 * 실행법:
 *   1) npm install        (express 설치)
 *   2) node server.js     (서버 시작)
 *   3) 브라우저에서 http://localhost:3000 접속
 *
 * 외부 API: Open-Meteo (무료, API 키 불필요)
 *   - 지오코딩: https://geocoding-api.open-meteo.com/v1/search
 *   - 현재날씨: https://api.open-meteo.com/v1/forecast
 *
 * ★ 함정 메모: Open-Meteo 지오코딩은 한글 도시명("서울","부산")으로
 *   검색하면 결과가 0건이다. 그래서 아래 KO_TO_ROMAN 맵으로 로마자
 *   변환 후 검색한다. (맵에 없으면 입력값 그대로 검색)
 */

const express = require('express');
const path = require('path');
const fs = require('fs');

const app = express();
const PORT = process.env.PORT || 3000;

// ── 한국 주요 도시 한글 → 로마자 별칭 맵 (지오코딩 0건 함정 회피) ──
const KO_TO_ROMAN = {
  '서울': 'Seoul',
  '부산': 'Busan',
  '인천': 'Incheon',
  '대구': 'Daegu',
  '대전': 'Daejeon',
  '광주': 'Gwangju',
  '울산': 'Ulsan',
  '수원': 'Suwon',
  '제주': 'Jeju',
  '춘천': 'Chuncheon',
  '강릉': 'Gangneung',
  '전주': 'Jeonju',
  '청주': 'Cheongju',
  '포항': 'Pohang',
  '창원': 'Changwon',
  '고양': 'Goyang',
  '성남': 'Seongnam',
  '용인': 'Yongin',
};

// ── WMO weather_code → 한글 날씨 매핑 ──
function weatherCodeToKorean(code) {
  const map = {
    0: '맑음',
    1: '구름 조금', 2: '구름 조금', 3: '흐림',
    45: '안개', 48: '안개',
    51: '이슬비', 53: '이슬비', 55: '이슬비', 56: '이슬비', 57: '이슬비',
    61: '비', 63: '비', 65: '비', 66: '비', 67: '비',
    71: '눈', 73: '눈', 75: '눈', 77: '눈',
    80: '소나기', 81: '소나기', 82: '소나기',
    85: '눈소나기', 86: '눈소나기',
    95: '뇌우', 96: '뇌우', 99: '뇌우',
  };
  return map[code] || '알 수 없음';
}

// ── 기온(℃) → 옷차림 가공 ──
function recommendOutfit(temp) {
  if (temp >= 28) {
    return {
      headline: '한여름, 반팔 OK 🥵',
      items: ['민소매', '반팔', '반바지', '린넨옷'],
      comment: '덥습니다! 시원하게 입으세요.',
    };
  }
  if (temp >= 23) {
    return {
      headline: '반팔하기 좋은 날 ☀️',
      items: ['반팔', '얇은 셔츠', '면바지', '반바지'],
      comment: '활동하기 딱 좋은 날씨예요.',
    };
  }
  if (temp >= 20) {
    return {
      headline: '얇은 가디건이 적당해요 🙂',
      items: ['얇은 가디건', '긴팔', '면바지', '청바지'],
      comment: '아침저녁으로 살짝 선선할 수 있어요.',
    };
  }
  if (temp >= 17) {
    return {
      headline: '선선해요, 얇은 겉옷 🍃',
      items: ['얇은 니트', '맨투맨', '가디건', '청바지'],
      comment: '얇은 겉옷 하나면 충분해요.',
    };
  }
  if (temp >= 12) {
    return {
      headline: '쌀쌀, 자켓 챙기세요 🧥',
      items: ['자켓', '야상', '가디건', '스타킹', '청바지'],
      comment: '바람이 차니 겉옷을 챙기세요.',
    };
  }
  if (temp >= 9) {
    return {
      headline: '코트가 필요한 날씨 🍂',
      items: ['트렌치코트', '야상', '니트', '청바지'],
      comment: '제법 쌀쌀하니 코트를 입으세요.',
    };
  }
  if (temp >= 5) {
    return {
      headline: '춥습니다, 두껍게! 🧣',
      items: ['코트', '가죽자켓', '히트텍', '니트', '목도리'],
      comment: '두껍게 입고 따뜻하게 다니세요.',
    };
  }
  return {
    headline: '패딩 필수! 🥶',
    items: ['패딩', '두꺼운 코트', '목도리', '장갑', '기모'],
    comment: '꽁꽁 싸매세요!',
  };
}

// ── 미들웨어: CORS 헤더 직접 처리 (file:// 직접 열기 대비) ──
app.use((req, res, next) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') {
    return res.sendStatus(204);
  }
  next();
});

// ── 외부 API JSON GET 헬퍼 (Node 24 global fetch 사용) ──
async function fetchJson(url) {
  const resp = await fetch(url);
  if (!resp.ok) {
    throw new Error(`외부 API 응답 오류 (status ${resp.status})`);
  }
  return resp.json();
}

// ── GET / → index.html 반환 ──
app.get('/', (_req, res) => {
  const indexPath = path.join(__dirname, 'index.html');
  if (!fs.existsSync(indexPath)) {
    return res
      .status(503)
      .send('index.html이 아직 준비되지 않았어요. 잠시 후 다시 시도해 주세요.');
  }
  res.sendFile(indexPath);
});

// ── GET /recommend?city=<도시> ──
app.get('/recommend', async (req, res) => {
  const rawCity = (req.query.city || '서울').toString().trim() || '서울';

  try {
    // 1) 지오코딩 (한글 → 로마자 변환 후 검색)
    const searchName = KO_TO_ROMAN[rawCity] || rawCity;
    const geoUrl =
      'https://geocoding-api.open-meteo.com/v1/search?name=' +
      encodeURIComponent(searchName) +
      '&count=1&language=ko';

    let geo;
    try {
      geo = await fetchJson(geoUrl);
    } catch (err) {
      return res
        .status(502)
        .json({ error: '날씨 서비스(지오코딩) 호출에 실패했어요.' });
    }

    if (!geo.results || geo.results.length === 0) {
      return res
        .status(404)
        .json({ error: `도시를 찾지 못했어요: ${rawCity}` });
    }

    const place = geo.results[0];
    const lat = place.latitude;
    const lon = place.longitude;

    // 2) 현재 날씨
    const fcUrl =
      'https://api.open-meteo.com/v1/forecast?latitude=' +
      lat +
      '&longitude=' +
      lon +
      '&current=temperature_2m,weather_code&timezone=Asia%2FSeoul';

    let forecast;
    try {
      forecast = await fetchJson(fcUrl);
    } catch (err) {
      return res
        .status(502)
        .json({ error: '날씨 서비스(예보) 호출에 실패했어요.' });
    }

    if (!forecast.current || typeof forecast.current.temperature_2m !== 'number') {
      return res
        .status(502)
        .json({ error: '날씨 데이터를 해석하지 못했어요.' });
    }

    const temperature = forecast.current.temperature_2m;
    const weather = weatherCodeToKorean(forecast.current.weather_code);
    const outfit = recommendOutfit(temperature);

    // 표시용 도시명: 한글 입력이면 입력값 유지, 아니면 지오코딩 이름 사용
    const displayCity = KO_TO_ROMAN[rawCity] ? rawCity : (place.name || rawCity);

    return res.json({
      city: displayCity,
      temperature,
      weather,
      headline: outfit.headline,
      items: outfit.items,
      comment: outfit.comment,
    });
  } catch (err) {
    return res
      .status(500)
      .json({ error: '서버 내부 오류가 발생했어요.' });
  }
});

// ── 그 외 → 404 ──
app.use((_req, res) => {
  res.status(404).json({ error: '요청하신 경로를 찾을 수 없어요.' });
});

// ── 서버 시작 ──
if (require.main === module) {
  app.listen(PORT, () => {
    console.log(`옷차림 추천 서버 실행: http://localhost:${PORT}`);
  });
}

module.exports = app;
