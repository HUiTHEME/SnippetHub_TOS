package main

import (
	"crypto/rand"
	"encoding/json"
	"net/http"
	"strconv"
	"strings"
	"sync"
	"time"
)

// 恢复码用于「忘记密码」时自助重置密码。
// 16 位随机字符（去掉 0/O/1/I 之类容易看错的），形如 ABCD-EFGH-JKLM-NPQR。
const recoveryAlphabet = "23456789ABCDEFGHJKLMNPQRSTUVWXYZ"

var recoverGuard = struct {
	sync.Mutex
	fails int
	until int64
}{}

func newRecoveryCode() string {
	b := make([]byte, 16)
	if _, err := rand.Read(b); err != nil {
		return ""
	}
	var sb strings.Builder
	for i, v := range b {
		if i > 0 && i%4 == 0 {
			sb.WriteByte('-')
		}
		sb.WriteByte(recoveryAlphabet[int(v)%len(recoveryAlphabet)])
	}
	return sb.String()
}

func normalizeRecovery(s string) string {
	s = strings.ToUpper(strings.TrimSpace(s))
	s = strings.ReplaceAll(s, "-", "")
	s = strings.ReplaceAll(s, " ", "")
	return s
}

// issueRecoveryLocked 生成新的恢复码并写入哈希，返回明文（只返回一次）。
func (a *api) issueRecoveryLocked() string {
	code := newRecoveryCode()
	if code == "" {
		return ""
	}
	salt := randHex(16)
	a.store.db.Settings.RecoverySalt = salt
	a.store.db.Settings.RecoveryHash = hashPassword(normalizeRecovery(code), salt)
	return code
}

// POST /api/recovery/rotate —— 登录后重新生成恢复码，返回明文。
func (a *api) rotateRecovery(w http.ResponseWriter, r *http.Request) {
	a.store.mu.Lock()
	if !a.store.db.Settings.Initialized {
		a.store.mu.Unlock()
		fail(w, 409, "尚未设置密码")
		return
	}
	code := a.issueRecoveryLocked()
	err := a.store.saveLocked()
	a.store.mu.Unlock()
	if err != nil || code == "" {
		fail(w, 500, "生成恢复码失败")
		return
	}
	writeJSON(w, 200, map[string]any{"ok": true, "code": code})
}

// POST /api/recover  { code, password } —— 凭恢复码重设密码（无需登录）。
func (a *api) recoverAccount(w http.ResponseWriter, r *http.Request) {
	recoverGuard.Lock()
	if recoverGuard.until > time.Now().Unix() {
		wait := recoverGuard.until - time.Now().Unix()
		recoverGuard.Unlock()
		fail(w, 429, "尝试次数过多，请 "+itoa(int(wait/60)+1)+" 分钟后再试")
		return
	}
	recoverGuard.Unlock()

	var in struct {
		Code     string `json:"code"`
		Password string `json:"password"`
	}
	if err := json.NewDecoder(r.Body).Decode(&in); err != nil {
		fail(w, 400, "参数错误")
		return
	}
	code := normalizeRecovery(in.Code)
	if len(code) != 16 {
		fail(w, 400, "恢复码格式不正确")
		return
	}
	if len(strings.TrimSpace(in.Password)) < 4 {
		fail(w, 400, "新密码至少需要 4 位")
		return
	}

	a.store.mu.Lock()
	st := a.store.db.Settings
	if !st.Initialized {
		a.store.mu.Unlock()
		fail(w, 409, "尚未设置密码")
		return
	}
	if st.RecoveryHash == "" {
		a.store.mu.Unlock()
		fail(w, 400, "恢复码已失效或从未生成。请用密码登录；忘记密码可在 NAS 上用命令行重置")
		return
	}
	if !verifyPassword(code, st.RecoverySalt, st.RecoveryHash) {
		a.store.mu.Unlock()
		recoverGuard.Lock()
		recoverGuard.fails++
		if recoverGuard.fails >= 5 {
			recoverGuard.fails = 0
			recoverGuard.until = time.Now().Add(5 * time.Minute).Unix()
		}
		recoverGuard.Unlock()
		fail(w, 401, "恢复码不正确")
		return
	}

	salt := randHex(16)
	a.store.db.Settings.Salt = salt
	a.store.db.Settings.PasswordHash = hashPassword(in.Password, salt)
	// 恢复码一次性使用，用掉即作废；同时立刻签发一个新的，让用户当场保存
	newCode := a.issueRecoveryLocked()
	if newCode == "" { // 极端情况下随机数失败：至少保证旧码已作废
		a.store.db.Settings.RecoveryHash = ""
		a.store.db.Settings.RecoverySalt = ""
	}
	err := a.store.saveLocked()
	a.store.mu.Unlock()

	recoverGuard.Lock()
	recoverGuard.fails = 0
	recoverGuard.until = 0
	recoverGuard.Unlock()

	if err != nil {
		fail(w, 500, "保存失败")
		return
	}
	dropAllSessions()
	writeJSON(w, 200, map[string]any{"ok": true, "recoveryCode": newCode})
}

func itoa(n int) string { return strconv.Itoa(n) }
