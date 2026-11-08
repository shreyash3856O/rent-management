# Google Play Store Release & Readiness Guide

## 1. Overview
This project provides a fully compliant, production-hardened Android application package (`com.rentledger.tenant`) and backend service engineered according to the latest **Google Play Developer Program Policies** (targeting **Android 14 / API Level 34**).

---

## 2. Mandatory Google Play Policy Compliance

### A. Account Deletion & Data Retention (Policy Requirement)
Google Play requires that apps enabling account creation MUST provide:
1. **An in-app mechanism for users to delete their account and personal data.**
   - Endpoint implemented: `POST /api/tenant/delete-account` (requires tenant JWT)
   - Behavior: Validates no active rental agreements or unpaid dues exist, wipes personal documents (`tenant_documents`), anonymizes profile records, and invalidates active OTPs.
2. **A web-based account deletion URL:**
   - Publicly accessible at: `https://<YOUR_DOMAIN>/privacy#account-deletion`
   - Clearly outlines requirements and contact details (`privacy@abcproperty.com`) for manual deletion requests.

### B. Privacy Policy & Disclosures
- **Public URL**: `https://<YOUR_DOMAIN>/privacy` (serves clean HTML) and `https://<YOUR_DOMAIN>/api/privacy-policy` (JSON).
- **Data Types Disclosed**:
  - Personal Info: Name, mobile number, email, date of birth, emergency contact.
  - Financial Info: Rent invoices, payment amounts, transaction references, security deposit balances, receipts.
  - Photos & Files: Identity verification documents (KYC Aadhaar, PAN, Passport), payment proof screenshots, maintenance photos.
  - Device / System: IP address and user-agent strings for financial audit trail.

### C. Declared Android Permissions (`AndroidManifest.xml`)
The app operates on the principle of least privilege:
- `android.permission.INTERNET`: Required for secure API communication over TLS/HTTPS.
- `android.permission.ACCESS_NETWORK_STATE`: For checking connectivity state and offline notices.
- `android.permission.CAMERA` (`android:required="false"`): For capturing KYC and complaint photos directly.
- `android.permission.READ_MEDIA_IMAGES` (API 33+): For attaching photos from gallery.
- `android.permission.READ_EXTERNAL_STORAGE` (`maxSdkVersion="32"`): Legacy compatibility.
- `android.permission.POST_NOTIFICATIONS`: For delivery of rent reminders and receipts.

---

## 3. Play Console Data Safety Form Filling Guide

When submitting the app in Google Play Console under **App Content > Data Safety**, fill in the form using these exact answers:

| Data Type | Collected? | Shared? | Purpose | Ephemeral? | Required / Optional |
|---|---|---|---|---|---|
| **Name** | Yes | No | Account management, App functionality | No | Required |
| **Email Address** | Yes | No | Account management, Invoicing, Receipts | No | Optional |
| **Phone Number** | Yes | No | Account management (OTP login), SMS reminders | No | Required |
| **Government ID (KYC)** | Yes | No | Fraud prevention, Legal tenancy verification | No | Required by landlord |
| **User Payment Info** | Yes | No | Payment reconciliation, Receipt issuance | No | Required |
| **Photos & Videos** | Yes | No | Tenancy verification, Maintenance complaints | No | Optional |

- **Security Practices**:
  - *Is data encrypted in transit?* **Yes** (All requests use TLS/HTTPS).
  - *Do you provide a way for users to request that their data is deleted?* **Yes** (In-app and via `https://<YOUR_DOMAIN>/privacy#account-deletion`).

---

## 4. Android Build & Package Generation

The native wrapper is located in `android/`:

### Building the Android App Bundle (`.aab` for Google Play)
```bash
# 1. Build frontend bundle
cd frontend
npm run build
cd ..

# 2. Build Android App Bundle using Gradle
cd android
./gradlew bundleRelease
```
The output `.aab` will be generated at:
`android/app/build/outputs/bundle/release/app-release.aab`

### Signing with Release Keystore
```bash
# Generate release keystore if not already created
keytool -genkeypair -v -storetype PKCS12 -keystore rentledger-release.keystore \
  -alias rentledger -keyalg RSA -keysize 2048 -validity 10000

# Sign the AAB bundle
jarsigner -verbose -sigalg SHA256withRSA -digestalg SHA-256 \
  -keystore rentledger-release.keystore \
  android/app/build/outputs/bundle/release/app-release.aab rentledger
```

---

## 5. App Store Listing Assets Checklist
- **App Name**: Rent Ledger: Property & Rent Management (under 30 characters)
- **Short Description**: Pay rent, track dues, view rental agreements, and file maintenance complaints (under 80 characters)
- **Full Description**: Comprehensive operational management for tenants and properties.
- **App Icon**: 512 x 512 PNG (generated at `frontend/public/icon-512.png`)
- **Feature Graphic**: 1024 x 500 PNG
- **Screenshots**: Minimum 2 phone screenshots (1080 x 1920 or 1080 x 2400)
- **Content Rating**: Complete IARC Questionnaire in Play Console (typically rated "Everyone / 3+")

