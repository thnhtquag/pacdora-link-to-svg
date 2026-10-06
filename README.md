# Pacdora Link → SVG mm (v2)

Bản v2 nhận trực tiếp URL Pacdora, mở trang bằng Playwright/Chromium, đọc đúng phần **Custom size**, cho phép đổi thông số rồi lấy dieline mới và xuất SVG vector theo mm.

## Flow
1. Paste URL Pacdora.
2. Backend mở URL bằng Chromium headless.
3. Tool chỉ dò các input nằm giữa `Custom size` và các section kế tiếp như `Choose material`, `Custom thickness`, `Size mode`.
4. User sửa kích thước ở web riêng.
5. Backend điền lại các input đó vào Pacdora và chờ dieline regenerate.
6. Chỉ lấy linework vector: bleed `#46ba00`, cut `#2028b0`, fold `#fa0000`.
7. Xoá/chặn `image`, `data:image`, `foreignObject`, node có `watermark`.
8. Tự suy ra `user unit / mm` từ measurement labels nếu có; fallback `1 unit = 1 mm`.
9. Trả SVG có `width="...mm"`, `height="...mm"` và `viewBox` đúng bounds.

## Chạy local
Yêu cầu Node 20+.

```bash
npm install
npx playwright install chromium
npm start
```

Mở `http://localhost:3000`.

## Deploy
Project có `Dockerfile`, phù hợp với Render/Railway/Fly.io hoặc VPS có Docker. Headless Chromium thường không phù hợp với static hosting như GitHub Pages/Netlify Drop.

### Render
- Push folder này lên GitHub.
- Render → New Web Service → chọn repo.
- Runtime: Docker.
- Health check: `/api/health`.

`render.yaml` đã được thêm sẵn. Lưu ý gói miễn phí/giới hạn tài nguyên có thể thay đổi theo thời gian.

## Hạn chế hiện tại
- Đây là browser automation, không phải API chính thức của Pacdora. Nếu Pacdora đổi UI/DOM thì selector có thể cần cập nhật.
- Một số template có custom controls không phải `<input>` thường có thể cần adapter riêng.
- Nếu Pacdora chặn headless browser/CAPTCHA hoặc yêu cầu login, phiên đó có thể không hoạt động.
- Session giữ trong RAM 10 phút; host restart thì cần Import lại link.

## Security
Backend chỉ cho phép URL thuộc `pacdora.com` hoặc subdomain của nó để tránh SSRF.
