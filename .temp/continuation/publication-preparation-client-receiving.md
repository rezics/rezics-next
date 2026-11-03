---
goal: content
manager: content
kind: claim
paths:
  - packages/client/src/kernel/**
  - packages/client/src/index.ts
riskAreas:
  - authorization
  - disclosure
  - rights
  - deletion
  - account
criticalPath: false
waiting: []
after:
  - 70cd2a89-afd1-437c-ba19-d9ebe380cc19
  - 799c5935-7f82-4008-8d2a-49c6ea01d740
  - 8e3516f6-5d8e-474d-a36a-31476cff3520
estimate:
  lines: 80
  files: 2
inseparable: true
---

# Receive publication preparation client types

After the shared complete-input generated delivery is available, consume its KernelClient declaration and export the installed publication preparation DTO from the package root. Do not start a generator or edit generated declarations in this receiving task. Preserve the existing Web subject picker caller contract and type-check `packages/client`. Retain the frozen publication preparation native acceptance and connected physical-plan and 256/1024/4096 growth proof for controller verification after integration.
