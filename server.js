const express = require('express');
const cors = require('cors');
const { recommend } = require('./recommend');
const itemsData = require('./items.json');
const mysql = require('mysql2');

const app = express();
app.use(cors());
app.use(express.json());

// ===== 数据库连接池 =====
const pool = mysql.createPool({
    host: 'localhost',
    user: 'campus_user',
    password: '123456789',  // 替换成你实际的数据库密码
    database: 'campus_db',
    waitForConnections: true,
    connectionLimit: 10,
    queueLimit: 0
});

// ===== 测试接口 =====
app.get('/test', (req, res) => {
    res.json({ msg: '后端运行正常！' });
});

// ===== 推荐接口（混合推荐） =====
app.get('/recommend', (req, res) => {
    const userId = parseInt(req.query.user_id) || 1;
    
    try {
        // 1. 协同过滤推荐
        let cfItems = recommend(userId);
        
        // 2. 如果协同过滤结果太少，补充热门商品
        if (cfItems.length < 5) {
            const hotItems = getHotItemsFromData();
            cfItems = cfItems.concat(hotItems);
        }
        
        // 3. 去重
        const seen = new Set();
        const merged = cfItems.filter(item => {
            if (seen.has(item.item_id)) return false;
            seen.add(item.item_id);
            return true;
        });
        
        // 4. 打乱顺序
        const shuffled = merged.sort(() => Math.random() - 0.5);
        
        // 5. 取前10条
        const result = shuffled.slice(0, 10);
        
        res.json({ code: 0, data: result });
    } catch (error) {
        console.error('推荐失败:', error);
        const hotItems = getHotItemsFromData();
        res.json({ code: 0, data: hotItems.slice(0, 10) });
    }
});

// ===== 热门接口 =====
app.get('/hot', (req, res) => {
    const ratings = require('./ratings.json');
    const itemCount = {};
    ratings.forEach(r => {
        itemCount[r.item_id] = (itemCount[r.item_id] || 0) + 1;
    });
    const sorted = Object.entries(itemCount)
        .sort((a, b) => b[1] - a[1])
        .slice(0, 10)
        .map(([itemId]) => parseInt(itemId));
    
    const hotItems = itemsData.filter(item => sorted.includes(item.item_id));
    res.json({ code: 0, data: hotItems });
});

// ===== 搜索接口 =====
app.get('/search', (req, res) => {
    const keyword = req.query.keyword || '';
    const results = itemsData.filter(item => 
        item.title.includes(keyword) || item.category.includes(keyword)
    );
    res.json({ code: 0, data: results });
});

// ===== 发布接口 =====
app.post('/publish', (req, res) => {
    const { title, category, price, user_id } = req.body;
    const newItem = {
        item_id: itemsData.length + 1,
        title,
        category,
        price: parseInt(price),
        user_id: user_id || 1,
        status: '在售',
        publishTime: new Date().toISOString()
    };
    itemsData.push(newItem);
    res.json({ code: 0, msg: '发布成功！', data: newItem });
});

// ===== 注册接口 =====
app.post('/register', async (req, res) => {
    const { username, password, nickname } = req.body;

    if (!username || !password) {
        return res.json({ code: 1, msg: '用户名和密码不能为空' });
    }

    try {
        const [rows] = await pool.promise().query(
            'SELECT * FROM users WHERE username = ?', [username]
        );
        if (rows.length > 0) {
            return res.json({ code: 1, msg: '用户名已被占用' });
        }

        const [result] = await pool.promise().query(
            'INSERT INTO users (username, password, nickname, avatar) VALUES (?, ?, ?, ?)',
            [username, password, nickname || username, '😊']
        );

        res.json({ code: 0, msg: '注册成功', data: { userId: result.insertId, username, nickname: nickname || username } });
    } catch (error) {
        console.error('注册失败:', error);
        res.json({ code: 1, msg: '服务器错误，请稍后重试' });
    }
});

// ===== 登录接口 =====
app.post('/login', async (req, res) => {
    const { username, password } = req.body;

    if (!username || !password) {
        return res.json({ code: 1, msg: '用户名和密码不能为空' });
    }

    try {
        const [rows] = await pool.promise().query(
            'SELECT * FROM users WHERE username = ?', [username]
        );

        if (rows.length === 0) {
            return res.json({ code: 1, msg: '用户不存在' });
        }

        const user = rows[0];
        if (user.password !== password) {
            return res.json({ code: 1, msg: '密码错误' });
        }

        res.json({
            code: 0,
            msg: '登录成功',
            data: { userId: user.id, username: user.username, nickname: user.nickname, avatar: user.avatar }
        });
    } catch (error) {
        console.error('登录失败:', error);
        res.json({ code: 1, msg: '服务器错误，请稍后重试' });
    }
});

// ===== 微信一键登录接口 =====
app.post('/wxlogin', async (req, res) => {
    const { code, nickName, avatarUrl } = req.body;
    
    if (!code) {
        return res.json({ code: 1, msg: '缺少code参数' });
    }

    try {
        // 微信官方接口 - 用 code 换 openid
        const appId = '你的小程序AppID';  // ⚠️ 替换成你的AppID
        const appSecret = '你的小程序AppSecret';  // ⚠️ 替换成你的AppSecret
        const wxUrl = `https://api.weixin.qq.com/sns/jscode2session?appid=${appId}&secret=${appSecret}&js_code=${code}&grant_type=authorization_code`;
        
        const response = await fetch(wxUrl);
        const data = await response.json();
        
        if (data.errcode) {
            console.error('微信登录失败:', data);
            return res.json({ code: 1, msg: '微信登录失败' });
        }

        const openId = data.openid;

        // 检查用户是否存在
        const [rows] = await pool.promise().query(
            'SELECT * FROM users WHERE openid = ?', [openId]
        );

        let userId;
        let userName;

        if (rows.length > 0) {
            userId = rows[0].id;
            userName = rows[0].nickname || nickName || '微信用户';
            await pool.promise().query(
                'UPDATE users SET nickname = ?, avatar = ? WHERE id = ?',
                [userName, avatarUrl || '', userId]
            );
        } else {
            const [result] = await pool.promise().query(
                'INSERT INTO users (openid, nickname, avatar, username) VALUES (?, ?, ?, ?)',
                [openId, nickName || '微信用户', avatarUrl || '', 'wx_' + openId.substring(0, 8)]
            );
            userId = result.insertId;
            userName = nickName || '微信用户';
        }

        res.json({
            code: 0,
            msg: '登录成功',
            data: {
                userId: userId,
                nickname: userName,
                openid: openId
            }
        });

    } catch (error) {
        console.error('微信登录失败:', error);
        res.json({ code: 1, msg: '服务器错误，请稍后重试' });
    }
});

// ===== 获取热门商品 =====
function getHotItemsFromData() {
    const ratings = require('./ratings.json');
    const itemCount = {};
    ratings.forEach(r => {
        itemCount[r.item_id] = (itemCount[r.item_id] || 0) + 1;
    });
    const sorted = Object.entries(itemCount)
        .sort((a, b) => b[1] - a[1])
        .slice(0, 10)
        .map(([itemId]) => parseInt(itemId));
    return itemsData
        .filter(item => sorted.includes(item.item_id))
        .map(item => ({ ...item, match_score: 80 }));
}

// ===== 启动服务器 =====
app.listen(5000, '0.0.0.0', () => {
    console.log('🚀 服务器运行在 http://localhost:5000');
    console.log('📝 测试地址: http://localhost:5000/test');
    console.log('📝 推荐地址: http://localhost:5000/recommend?user_id=1');
});
