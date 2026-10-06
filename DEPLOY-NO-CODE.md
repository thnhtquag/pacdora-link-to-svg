# CÁCH ĐƯA WEB LÊN MẠNG — KHÔNG CẦN BIẾT CODE

Bạn chỉ cần GitHub + Render. Không cần Netlify.

## Bước 1 — Đưa project lên GitHub
1. Vào https://github.com và đăng nhập / tạo tài khoản.
2. Bấm dấu **+** góc phải → **New repository**.
3. Đặt tên: `pacdora-link-to-svg`.
4. Chọn **Private** hoặc **Public** đều được.
5. Bấm **Create repository**.
6. Trong repo mới, bấm **uploading an existing file** / **Add file → Upload files**.
7. Giải nén file ZIP project này trên máy.
8. Kéo TẤT CẢ file/folder bên trong vào GitHub, gồm:
   - `Dockerfile`
   - `server.js`
   - `package.json`
   - `render.yaml`
   - folder `public`
9. Bấm **Commit changes**.

## Bước 2 — Deploy bằng Render
1. Vào https://dashboard.render.com và đăng nhập bằng GitHub.
2. Bấm **New +** → **Web Service**.
3. Chọn repo `pacdora-link-to-svg`.
4. Render sẽ thấy `Dockerfile`. Chọn runtime/language **Docker** nếu được hỏi.
5. Chọn plan **Free** để thử.
6. Health Check Path: `/api/health` nếu Render hỏi.
7. Bấm **Create Web Service / Deploy Web Service**.
8. Đợi build xong. Lần đầu có thể mất vài phút vì phải cài Chromium.
9. Khi trạng thái là **Live**, mở link dạng:
   `https://pacdora-link-to-svg.onrender.com`

## Sau này cập nhật web
Khi ChatGPT gửi bản mới:
1. Vào repo GitHub.
2. Upload đè các file mới.
3. Commit changes.
4. Render tự deploy lại.

## Lưu ý bản Free
Render Free có thể ngủ sau một thời gian không sử dụng. Lần mở đầu tiên sau khi ngủ sẽ chậm hơn. Chromium/Playwright cũng tương đối nặng; nếu Free thiếu RAM, cần nâng compute plan hoặc chuyển host.
