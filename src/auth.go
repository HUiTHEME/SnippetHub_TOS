package main

import (
	"crypto/hmac"
	"crypto/rand"
	"crypto/sha256"
	"crypto/subtle"
	"encoding/binary"
	"encoding/hex"
	"sync"
	"time"
)

const (
	sessionCookie = "sh_sid"
	sessionTTL    = 30 * 24 * time.Hour
	pbkdf2Rounds  = 210000
)

var sessions = struct {
	sync.Mutex
	m map[string]int64
}{m: map[string]int64{}}

func randHex(n int) string {
	b := make([]byte, n)
	if _, err := rand.Read(b); err != nil {
		return hex.EncodeToString([]byte(time.Now().String()))
	}
	return hex.EncodeToString(b)
}

// pbkdf2Key 是标准 PBKDF2-HMAC-SHA256 的本地实现（避免引入外部依赖）。
func pbkdf2Key(password, salt []byte, iter, keyLen int) []byte {
	prf := hmac.New(sha256.New, password)
	hashLen := prf.Size()
	numBlocks := (keyLen + hashLen - 1) / hashLen

	var buf [4]byte
	dk := make([]byte, 0, numBlocks*hashLen)
	u := make([]byte, hashLen)

	for block := 1; block <= numBlocks; block++ {
		prf.Reset()
		prf.Write(salt)
		binary.BigEndian.PutUint32(buf[:], uint32(block))
		prf.Write(buf[:])
		dk = prf.Sum(dk)
		t := dk[len(dk)-hashLen:]
		copy(u, t)

		for n := 2; n <= iter; n++ {
			prf.Reset()
			prf.Write(u)
			u = prf.Sum(u[:0])
			for x := range u {
				t[x] ^= u[x]
			}
		}
	}
	return dk[:keyLen]
}

// hashPassword 用 pbkdf2-sha256 做口令派生。
func hashPassword(password, salt string) string {
	key := pbkdf2Key([]byte(password), []byte(salt), pbkdf2Rounds, 32)
	return hex.EncodeToString(key)
}

func verifyPassword(password, salt, want string) bool {
	got := hashPassword(password, salt)
	return subtle.ConstantTimeCompare([]byte(got), []byte(want)) == 1
}

func newSession() string {
	token := randHex(24)
	sessions.Lock()
	// 单用户应用，正常只有几台设备在线；这里兜个上限，
	// 万一有人拿密码疯狂登录，也不会把内存撑大。
	if len(sessions.m) >= maxSessions {
		oldestTok, oldestExp := "", int64(1<<62)
		for t, exp := range sessions.m {
			if exp < oldestExp {
				oldestTok, oldestExp = t, exp
			}
		}
		delete(sessions.m, oldestTok)
	}
	sessions.m[token] = time.Now().Add(sessionTTL).Unix()
	sessions.Unlock()
	return token
}

// maxSessions 同时有效的登录态上限。
const maxSessions = 256

// sweepSessions 清掉过期会话。过期 token 平时只在被访问时才删除，
// 长期运行的进程如果只是偶尔登录，map 里会一直留着旧条目。
func sweepSessions() {
	now := time.Now().Unix()
	sessions.Lock()
	for t, exp := range sessions.m {
		if exp < now {
			delete(sessions.m, t)
		}
	}
	sessions.Unlock()
}

// startSessionSweeper 在后台每小时扫一次，开销可以忽略。
func startSessionSweeper() {
	go func() {
		t := time.NewTicker(time.Hour)
		defer t.Stop()
		for range t.C {
			sweepSessions()
		}
	}()
}

func sessionValid(token string) bool {
	if token == "" {
		return false
	}
	sessions.Lock()
	defer sessions.Unlock()
	exp, ok := sessions.m[token]
	if !ok {
		return false
	}
	if exp < time.Now().Unix() {
		delete(sessions.m, token)
		return false
	}
	return true
}

func dropSession(token string) {
	sessions.Lock()
	delete(sessions.m, token)
	sessions.Unlock()
}

func dropAllSessions() {
	sessions.Lock()
	sessions.m = map[string]int64{}
	sessions.Unlock()
}

// dropOtherSessions 保留当前会话，把其它设备上的登录态全部踢掉（改密码后用）。
func dropOtherSessions(keep string) {
	sessions.Lock()
	for t := range sessions.m {
		if t != keep {
			delete(sessions.m, t)
		}
	}
	sessions.Unlock()
}

// 登录节流：连续输错会越等越久，避免有人对着 4 位密码一直猜。
// 单用户 NAS 上按进程计数就够，不需要按 IP。
var loginGuard = struct {
	sync.Mutex
	fails int
	until int64
}{}

// loginLocked 返回还需要等待的秒数；0 表示现在可以试。
func loginLocked() int64 {
	loginGuard.Lock()
	defer loginGuard.Unlock()
	if loginGuard.until <= time.Now().Unix() {
		return 0
	}
	return loginGuard.until - time.Now().Unix()
}

func loginFailed() {
	loginGuard.Lock()
	loginGuard.fails++
	if n := loginGuard.fails; n >= 3 {
		// 3 次起：10s、20s、40s…最长 5 分钟
		wait := 10 << uint(min(n-3, 5))
		if wait > 300 {
			wait = 300
		}
		loginGuard.until = time.Now().Add(time.Duration(wait) * time.Second).Unix()
	}
	loginGuard.Unlock()
}

func loginSucceeded() {
	loginGuard.Lock()
	loginGuard.fails = 0
	loginGuard.until = 0
	loginGuard.Unlock()
}
