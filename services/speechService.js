const axios = require('axios');

class SpeechService {
  constructor() {
    this.accessToken = null;
    this.tokenExpireTime = 0;
  }

  // 获取百度访问令牌
  async getBaiduAccessToken(apiKey, secretKey) {
    const now = Date.now();
    if (this.accessToken && now < this.tokenExpireTime) {
      return this.accessToken;
    }

    try {
      const response = await axios.post(
        'https://aip.baidubce.com/oauth/2.0/token',
        null,
        {
          params: {
            grant_type: 'client_credentials',
            client_id: apiKey,
            client_secret: secretKey
          }
        }
      );
      
      this.accessToken = response.data.access_token;
      this.tokenExpireTime = now + (response.data.expires_in - 60) * 1000;
      return this.accessToken;
    } catch (error) {
      console.error('获取百度访问令牌失败:', error);
      throw error;
    }
  }

  // 百度语音识别
  async baiduSpeechToText(audioData, apiKey, secretKey) {
    try {
      const accessToken = await this.getBaiduAccessToken(apiKey, secretKey);
      
      const response = await axios.post(
        'https://vop.baidu.com/server_api',
        {
          format: 'wav',
          rate: 16000,
          channel: 1,
          cuid: 'interview-assistant',
          token: accessToken,
          speech: audioData.toString('base64'),
          len: audioData.length
        },
        {
          headers: {
            'Content-Type': 'application/json'
          }
        }
      );

      if (response.data.err_no === 0) {
        return response.data.result[0];
      } else {
        throw new Error(response.data.err_msg);
      }
    } catch (error) {
      console.error('百度语音识别失败:', error);
      throw error;
    }
  }
}

module.exports = new SpeechService();
