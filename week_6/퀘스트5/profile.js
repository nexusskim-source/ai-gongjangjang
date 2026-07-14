// 프로필(사진) 공용 모듈 - 로컬 server.js + Vercel api/*.js 에서 함께 사용.
// ImageKit(https://imagekit.io) 로 프로필 사진을 업로드한다.
//  - 브라우저가 파일을 ImageKit 업로드 API 로 직접 올린다(서버로 파일이 지나가지 않음).
//  - 다만 업로드에는 서버 서명(signature)이 필요하다. 서명은 private key 로만 만들 수 있어
//    서버(여기)에서 생성해 프런트에 내려준다. private key 는 절대 프런트로 보내지 않는다.
//  - 업로드가 끝나면 프런트가 받은 이미지 URL 을 서버에 저장(PUT /api/profile)한다.
const crypto = require('crypto');
const auth = require('./auth');

// 공개 정보(공개키/URL엔드포인트)는 노출돼도 안전하다. env 로 덮어쓸 수 있게 하되 기본값을 둔다.
const PUBLIC_KEY = (process.env.IMAGEKIT_PUBLIC_KEY || 'public_kgj+PO8fmPOHSnZbyjT4tVSC/SU=').trim();
const URL_ENDPOINT = (process.env.IMAGEKIT_URL_ENDPOINT || 'https://ik.imagekit.io/ngyvoa04b').trim();

function getPrivateKey() {
  const k = (process.env.IMAGEKIT_PRIVATE_KEY || '').trim();
  if (!k) throw auth.httpError(500, '서버에 IMAGEKIT_PRIVATE_KEY 가 설정되지 않았습니다. .env 를 확인하세요.');
  return k;
}

// shop_users 에 profile_image 컬럼 보장 (없으면 추가).
async function ensureProfileSchema(pool) {
  await pool.query(
    "ALTER TABLE shop_users ADD COLUMN IF NOT EXISTS profile_image TEXT NOT NULL DEFAULT ''"
  );
}

// ImageKit 클라이언트 업로드용 인증 파라미터 생성.
// signature = HMAC-SHA1(token + expire, privateKey) (hex)
// expire 는 유닉스초, 지금부터 1시간 이내여야 한다(ImageKit 규칙). 여기선 10분 뒤로 둔다.
function getUploadAuthParams() {
  const token = crypto.randomUUID();
  const expire = Math.floor(Date.now() / 1000) + 10 * 60; // 10분
  const signature = crypto
    .createHmac('sha1', getPrivateKey())
    .update(token + expire)
    .digest('hex');
  return { token, expire, signature, publicKey: PUBLIC_KEY, urlEndpoint: URL_ENDPOINT };
}

// 저장할 이미지 URL 검증: 반드시 우리가 설정한 ImageKit 엔드포인트에서 온 것이어야 한다.
// (임의 외부 URL 을 프로필에 심는 것을 막는다.)
function isAllowedImageUrl(url) {
  const u = String(url || '').trim();
  if (!u) return false;
  return u.startsWith(URL_ENDPOINT + '/') || u.startsWith('https://ik.imagekit.io/');
}

async function getProfile(pool, userId) {
  await ensureProfileSchema(pool);
  const { rows } = await pool.query(
    'SELECT id, username, profile_image FROM shop_users WHERE id = $1',
    [userId]
  );
  if (rows.length === 0) throw auth.httpError(404, '사용자를 찾을 수 없습니다.');
  const r = rows[0];
  return { success: true, id: r.id, username: r.username, profileImage: r.profile_image || '' };
}

// 프로필 사진 URL 저장. 빈 문자열이면 기본(사진 없음)으로 되돌린다.
async function setProfileImage(pool, userId, body) {
  await ensureProfileSchema(pool);
  const url = String((body && body.profileImage) || '').trim();
  if (url && !isAllowedImageUrl(url)) {
    throw auth.httpError(400, '허용되지 않은 이미지 주소입니다.');
  }
  const { rows } = await pool.query(
    'UPDATE shop_users SET profile_image = $1 WHERE id = $2 RETURNING id, username, profile_image',
    [url, userId]
  );
  if (rows.length === 0) throw auth.httpError(404, '사용자를 찾을 수 없습니다.');
  const r = rows[0];
  return { success: true, id: r.id, username: r.username, profileImage: r.profile_image || '' };
}

module.exports = {
  ensureProfileSchema,
  getUploadAuthParams,
  getProfile,
  setProfileImage,
  PUBLIC_KEY,
  URL_ENDPOINT,
};
