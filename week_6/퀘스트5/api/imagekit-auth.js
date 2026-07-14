// Vercel 서버리스 함수: GET /api/imagekit-auth
// 프런트가 ImageKit 에 파일을 직접 업로드하기 전에 서버 서명을 받아간다.
// private key 는 서버 비밀 — 응답에 절대 포함하지 않는다.
const auth = require('../auth');
const profile = require('../profile');

module.exports = async (req, res) => {
  try {
    const user = auth.getUserFromReq(req);
    if (!user) {
      return res.status(401).json({ success: false, message: '로그인이 필요합니다.' });
    }
    if (req.method !== 'GET') {
      return res.status(405).json({ success: false, message: 'Method Not Allowed' });
    }
    return res.status(200).json(profile.getUploadAuthParams());
  } catch (err) {
    const status = err.status || 500;
    if (status >= 500) console.error('ImageKit 인증 오류:', err);
    return res.status(status).json({ success: false, message: err.message || '서버 오류' });
  }
};
