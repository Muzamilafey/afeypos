# HR and payroll

*People → Employees, Payroll, Leave & advances, Attendance* (module **HR & payroll**). HR runs on the head-office server, or on a standalone shop server. Branch servers show HR as managed at HQ.

## Employees

- Each employee has an employee number (`EMP-0001`, shared with their staff login and card). Their record holds:
  - national ID, KRA PIN, NSSF and SHA/SHIF numbers;
  - branch, department and job title;
  - employment type (permanent, contract, casual);
  - pay: monthly salary, daily rate or hourly rate;
  - monthly allowances (taxable or not) and deductions after tax (SACCO, welfare, loans), plus any extra pension;
  - payment method (M-Pesa number, bank account or cash);
  - annual leave days.
- *Add staff logins* creates an employee record for every user without one. Linking the record to the login is what lets their clock-in records feed payroll.

## Attendance

Staff clock in and out on the sign-in screen with their staff card (+PIN) or fingerprint (see BIOMETRICS.md). *Attendance* shows days present and hours per month, with CSV export. Daily and hourly staff are paid from these records unless the payslip is adjusted.

## Leave

- Types: annual, sick, maternity, paternity, compassionate, unpaid.
- Days are counted Monday to Saturday unless entered.
- Annual leave accrues monthly from the entitlement (21 days by default, Employment Act), plus days brought forward. Requests beyond the available balance are refused.
- Approved **unpaid** leave reduces a monthly salary by basic ÷ 26 per day.

## Salary advances

1. An advance is requested with a monthly recovery instalment.
2. A **different person** approves it (`payroll.approve`); owners and business administrators may approve their own.
3. It is paid in cash or by bank, or as an M-Pesa payout that is approved and sent under *M-Pesa payouts*.
4. Payroll recovers it by instalment until it is settled. Recovery is limited so take-home pay stays at least one third of gross (Employment Act s. 19(3)), and it can be skipped for a month.

## Payroll

1. *Run payroll* for a month (all staff, or one branch). Each payslip is calculated:
   - **Gross** = basic (or rate × days/hours) + allowances + overtime + bonus − unpaid leave.
   - **NSSF**: 6 % on pay up to KES 8,000 (tier I) and 6 % on pay from 8,000 to 72,000 (tier II), employee and employer.
   - **SHIF**: 2.75 % of gross, minimum KES 300.
   - **Affordable Housing Levy**: 1.5 % employee + 1.5 % employer.
   - **PAYE** on taxable pay = gross − non-taxable allowances − NSSF − pension − SHIF − housing levy:
     - 10 % up to 24,000; 25 % up to 32,333; 30 % up to 500,000; 32.5 % up to 800,000; 35 % above;
     - less the personal relief of KES 2,400.
   - **NITA** KES 50 per employee (employer).
   - Net = gross − statutory deductions − other deductions − advance recovery.

   Example, KES 50,000 basic: NSSF 3,000, SHIF 1,375, levy 750, taxable 44,875, PAYE 5,845.85, **net 39,029.15**.
2. Adjust payslips while in draft: days or hours worked, overtime, bonus, one-off allowances or deductions. *Recalculate* picks up employee changes.
3. **Approve.** This must be a different person from whoever prepared the run (owners and business administrators may approve their own); advance recoveries are booked at this point.
4. **Pay:**
   - *Pay by M-Pesa* creates B2C salary payouts in whole shillings. Someone with `payouts.approve` approves and sends them under *M-Pesa payouts*, and each payslip is marked paid when Safaricom confirms it.
   - *Bank file* exports a CSV for the bank.
   - *Mark bank / cash paid* records the rest.

   The run is *paid* when every payslip is.
5. **Payslips:** print or save them as PDF (A5), all at once or per employee.
6. **Statutory returns:** *PAYE / SHIF / NSSF* exports the monthly schedule per employee:
   - KRA PIN, gross, NSSF, SHIF, housing levy and taxable pay;
   - tax charged, relief and PAYE.

   Use it for the iTax P10 return, the SHA (SHIF) and NSSF returns, and the housing levy return (all due by the 9th of the following month).

Cancelling a payroll (before any payment) gives recovered advances back.

## Permissions

| Permission | Who | Allows |
|---|---|---|
| `hr.manage` | owners, administrators, branch managers | employees, leave, attendance, advance requests |
| `payroll.manage` | owners, administrators, accountants | prepare payroll, payslips, returns, payment |
| `payroll.approve` | owners, administrators | approve payroll and advances (never their own) |
| `payouts.request` / `payouts.approve` | see MPESA.md | create / approve and send M-Pesa payouts |

## Verification status

- **Rates:** the statutory rates are those in force from February 2025: NSSF year 3 limits; SHIF; the housing levy; and PAYE allowing SHIF and the levy as deductions (Tax Laws (Amendment) Act 2024). They live in one place, `server/src/modules/hr/statutory.ts` (`KENYA_2025`), so a Finance Act change is a single edit.
- **Before relying on them:** check the figures against KRA's PAYE calculator and the current SHA/NSSF notices before filing.
- **Not supported:** the disability exemption, insurance and mortgage relief, the higher-rate pension limits for specific schemes, and the exact iTax P10 spreadsheet layout (the export has the figures, which you copy into KRA's template).
