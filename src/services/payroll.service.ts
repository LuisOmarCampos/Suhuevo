// payroll.service.ts
import moment, { Moment } from "moment";
import * as ExcelJS from "exceljs";
import { AppErrorResponse } from "@app/models/app.response";
import { AttendanceModel } from "@app/repositories/mongoose/models/attendance.model";
import { EmployeeModel } from "@app/repositories/mongoose/models/employee.model";
import { PayrollModel } from "@app/repositories/mongoose/models/payroll.model";
import { AbsenceModel } from "@app/repositories/mongoose/models/absence.model";
import { OvertimeModel } from "@app/repositories/mongoose/models/overtime.model";
import { PersonalBonusModel } from "@app/repositories/mongoose/models/personal-bonus.model";
import { BonusModel } from "@app/repositories/mongoose/models/bonus.model";
import { DepartmentModel } from "@app/repositories/mongoose/models/department.model";
import { JobModel } from "@app/repositories/mongoose/models/job.model";
import { bigMath } from "@app/utils/math.util";
import { formatParse, getNextDay } from "@app/utils/date.util";
import { consumeSequence } from "@app/utils/sequence";
import { groupBy, sumField } from "@app/utils/util.util";
import type { ClientSession } from "mongoose";
import { IEmployee, EEmployeStatus, EEmployeeAttendanceScheme, IEmployeSchedule } from "@app/dtos/employee.dto";
import { IPayroll, SchemaGenerateWeeklyPayroll } from "@app/dtos/payroll.dto";
import { BonusType, IBonus } from "@app/dtos/bonus.dto";
import { IPersonalBonus } from "@app/dtos/personal-bonus.dto";

// ------------------- Helpers -------------------
const defaultDateFormat = "YYYY-MM-DD";

function formatDate(date: Moment): string {
  return date.format("DD/MM/YYYY");
}

function getEmployeeFullName(employee: IEmployee): string {
  return `${employee.name} ${employee.lastName || ""} ${employee.secondLastName || ""}`.trim();
}

// Log con colores (ANSI)
function customLogColored(message: string, color: "green" | "yellow" | "blue" | "red" = "green"): void {
  const colors: Record<string, string> = {
    green: "\x1b[32m",
    yellow: "\x1b[33m",
    blue: "\x1b[34m",
    red: "\x1b[31m",
  };
  const reset = "\x1b[0m";
  console.log(`${colors[color]}[${moment().format("DD/MM/YYYY, HH:mm:ss")}]: ${message}${reset}`);
}

// ------------------- Servicio de Nómina -------------------
class PayrollService {
  private readonly weekStartDay = 3; // Miércoles
  private readonly weekCutOffDay = 2; // Martes (día de corte)

  // Retorna el rango de semana (de miércoles a martes siguiente) basado en la fecha dada.
  private getWeekRange(date: Moment): { weekStart: Moment; weekEnd: Moment } {
    const weekday = date.isoWeekday(); // Monday=1, Tuesday=2, Wednesday=3, etc.
    let weekStart: Moment;
    if (weekday >= 3) {
      weekStart = date
        .clone()
        .subtract(weekday - 3, "days")
        .startOf("day");
    } else {
      weekStart = date
        .clone()
        .subtract(weekday + 4, "days")
        .startOf("day");
    }
    const weekEnd = weekStart.clone().add(6, "days").endOf("day");
    return { weekStart, weekEnd };
  }

  // -------------------- BÚSQUEDA --------------------
  public async search(query: any): Promise<any> {
    const { limit = 100, size, ...queryFields } = query;
    const allowedFields: (keyof IPayroll)[] = ["id", "name", "startDate", "cutoffDate"];
    const filter: any = { active: true };
    const selection: any = size === "small" ? {} : { active: 0, _id: 0, __v: 0 };

    for (const field in queryFields) {
      const cleanField = field.replace(/[~<>]/, "");
      if (!(allowedFields as any[]).includes(cleanField)) {
        throw new AppErrorResponse({ statusCode: 403, name: `Campo no permitido: ${field}` });
      }
      const value = queryFields[field];
      if (Array.isArray(value)) {
        filter[cleanField] = { $in: value };
      } else if (field.startsWith("~")) {
        filter[cleanField] = new RegExp(String(value).replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "i");
      } else if (field.startsWith("<")) {
        filter[cleanField] = { ...filter[cleanField], $lt: value };
      } else if (field.startsWith(">")) {
        filter[cleanField] = { ...filter[cleanField], $gt: value };
      } else {
        filter[cleanField] = value;
      }
    }
    const records = await PayrollModel.find(filter).select(selection).limit(limit).sort({ createdAt: "desc" });
    if (records.length === 0) return [];
    return this.populateResults(records);
  }

  public async populateResults(array: IPayroll[]): Promise<any> {
    const populatedArray = JSON.parse(JSON.stringify(array));
    for (const record of populatedArray) {
      record.totalAmount = record.lines.reduce((sum: number, line: any) => sum + Number(line.netPay), 0).toFixed(2);
    }
    return populatedArray;
  }

  // -------------------- GENERACIÓN DE NÓMINA SEMANAL --------------------
  /**
   * Si se envía el parámetro preview en el body (preview=true), retorna un arreglo de objetos de
   * vista previa con los campos: ID, Nombre, Departamento, Puesto, Esquema, Salario Diario y Estimado Semanal.
   * El "Estimado Semanal" se calcula multiplicando el salario diario por la cantidad de días del esquema
   * (convertido a número; si no es numérico se asume 5).
   *
   * Si preview no es true, se genera la nómina completa (calculando asistencias, ausencias, horas extra,
   * bonos, etc.) y se guarda en la base de datos.
   */
  async executeWeeklyPayroll(body: any, session: ClientSession): Promise<any> {
    customLogColored(`Body de la solicitud: ${body.String}`, "blue");
    if (body.preview) {
      customLogColored("Modo preview activado: Generando vista previa de nómina", "blue");
      // Para preview se utiliza el parámetro weekStartDate (se espera que sea un miércoles)
      const weekStartDate = formatParse(body.weekStartDate);
      // Para la vista previa, se obtiene la lista de empleados activos con populate de job y department
      const employees: (IEmployee & { job?: any; department?: any })[] = await EmployeeModel.find(
        { active: true, status: EEmployeStatus.ACTIVE },
        null,
        { session }
      )
        .populate(["job", "department"])
        .exec();
      const previewData = employees.map((emp) => {
        const id = emp.id;
        const employeeName = getEmployeeFullName(emp);
        const department = emp.department ? emp.department.name : "Sin Departamento";
        const job = emp.job ? emp.job.name : "";
        const esquema = emp.jobScheme;
        const daysInScheme = !isNaN(Number(esquema)) ? Number(esquema) : 5;
        const dailySalary = Number(emp.dailySalary.toFixed(2));
        const estimatedWeekly = Number((dailySalary * daysInScheme).toFixed(2));
        return {
          id,
          employeeName,
          department,
          job,
          esquema,
          dailySalary,
          estimatedWeekly,
        };
      });
      customLogColored(`Vista previa generada para ${previewData.length} empleados`, "green");
      customLogColored(`Ejemplo de vista previa: ${JSON.stringify(previewData[0])}`, "yellow");
      return previewData;
    } else {
      return await this.generateWeeklyPayroll(body, session);
    }
  }

  /**
   * Genera la nómina semanal completa a partir de registros de asistencias, ausencias y horas extra.
   * Se guarda el registro en la base de datos.
   */
  async generateWeeklyPayroll(body: SchemaGenerateWeeklyPayroll, session: ClientSession): Promise<any> {
    const weekStartDate = formatParse(body.weekStartDate);
    const weekCutoffDate = getNextDay(weekStartDate, this.weekCutOffDay);
    const formattedWeekStartDate = weekStartDate.format("YYYY-MM-DD");
    const formattedWeekCutoffDate = weekCutoffDate.format("YYYY-MM-DD");

    customLogColored(`Generando nómina para la semana: ${formattedWeekStartDate} a ${formattedWeekCutoffDate}`, "blue");

    // Consultar registros dentro del período
    const attendances = await AttendanceModel.find(
      { active: true, date: { $gte: formattedWeekStartDate, $lte: formattedWeekCutoffDate } },
      null,
      { session }
    ).exec();
    const absences = await AbsenceModel.find(
      { active: true, isJustified: false, date: { $gte: formattedWeekStartDate, $lte: formattedWeekCutoffDate } },
      null,
      { session }
    ).exec();
    const paidAbsences = await AbsenceModel.find(
      { active: true, isPaid: true, date: { $gte: formattedWeekStartDate, $lte: formattedWeekCutoffDate } },
      null,
      { session }
    ).exec();
    const justifiedAbsences = await AbsenceModel.find(
      { active: true, isJustified: true, date: { $gte: formattedWeekStartDate, $lte: formattedWeekCutoffDate } },
      null,
      { session }
    ).exec();
    const overtimeRecords = await OvertimeModel.find(
      { active: true, startTime: { $gte: formattedWeekStartDate, $lte: formattedWeekCutoffDate } },
      null,
      { session }
    ).exec();

    // Agrupar registros por empleado
    const attendancesByEmployee = groupBy(attendances, "employeeId");
    const absencesByEmployee = groupBy(absences, "employeeId");
    const paidAbsencesByEmployee = groupBy(paidAbsences, "employeeId");
    const justifiedAbsencesByEmployee = groupBy(justifiedAbsences, "employeeId");
    const overtimeRecordsByEmployee = groupBy(overtimeRecords, "employeeId");

    const fiveDaysSchemeBase = bigMath.chain(2).divide(5).done();
    const sixDaysSchemeBase = bigMath.chain(1).divide(6).done();

    // Bonos generales y personales
    const bonusOvertime = await BonusModel.findOne({ active: true, inputId: "horas_extra", enabled: true }).exec();
    const bonusAttendance = await BonusModel.findOne({ active: true, inputId: "asistencia", enabled: true }).exec();
    const bonusPunctuality = await BonusModel.findOne({ active: true, inputId: "puntualidad", enabled: true }).exec();
    const bonusGrocery = await BonusModel.findOne({ active: true, inputId: "despensa", enabled: true }).exec();
    const bonusPackageH = await BonusModel.findOne({ active: true, inputId: "empaque_h", enabled: true }).exec();
    const bonusPackageM = await BonusModel.findOne({ active: true, inputId: "empaque_m", enabled: true }).exec();
    const bonusShed = await BonusModel.findOne({ active: true, inputId: "caseta", enabled: true }).exec();

    const personalBonusOvertime = await PersonalBonusModel.find({
      active: true,
      entityType: "bonus",
      entityId: bonusOvertime?._id,
      enabled: true,
    }).exec();
    const personalBonusAttendance = await PersonalBonusModel.find({
      active: true,
      entityType: "bonus",
      entityId: bonusAttendance?._id,
      enabled: true,
    }).exec();
    const personalBonusPunctuality = await PersonalBonusModel.find({
      active: true,
      entityType: "bonus",
      entityId: bonusPunctuality?._id,
      enabled: true,
    }).exec();
    const personalBonusGrocery = await PersonalBonusModel.find({
      active: true,
      entityType: "bonus",
      entityId: bonusGrocery?._id,
      enabled: true,
    }).exec();
    const personalBonusPackageH = await PersonalBonusModel.find({
      active: true,
      entityType: "empaque_h",
      entityId: bonusPackageH?._id,
      enabled: true,
    }).exec();
    const personalBonusPackageM = await PersonalBonusModel.find({
      active: true,
      entityType: "empaque_m",
      entityId: bonusPackageH?._id,
      enabled: true,
    }).exec();
    const personalBonusShed = await PersonalBonusModel.find({
      active: true,
      entityType: "caseta",
      entityId: bonusShed?._id,
      enabled: true,
    }).exec();

    // Listado de empleados activos con populate de job y department
    const employees: (IEmployee & { job?: any; department?: any })[] = await EmployeeModel.find(
      { active: true, status: EEmployeStatus.ACTIVE },
      null,
      { session }
    )
      .populate(["job", "department"])
      .exec();

    const lines: any[] = [];

    for (const [index, employee] of employees.entries()) {
      const dailySalary = Number(employee.dailySalary.toFixed(2));
      const jobScheme = employee.jobScheme;
      const employeeFullName = getEmployeeFullName(employee);
      const clabe = employee.bankAccountNumber || "";
      const curp = employee.mxCurp || "";
      const nss = employee.mxNss || "";

      const empAttendances = attendancesByEmployee[employee.id] || [];
      const empAbsences = absencesByEmployee[employee.id] || [];
      const empPaidAbsences = paidAbsencesByEmployee[employee.id] || [];
      const empJustifiedAbsences = justifiedAbsencesByEmployee[employee.id] || [];
      const empOvertimeRecords = overtimeRecordsByEmployee[employee.id] || [];
      const employeeTardies = empAttendances.filter((a) => a.isLate);

      // Días trabajados = asistencias + ausencias pagadas + faltas justificadas
      const daysWorked = empAttendances.length + empPaidAbsences.length + empJustifiedAbsences.length;
      const restDaysMultiplier = jobScheme === "5" ? fiveDaysSchemeBase : sixDaysSchemeBase;
      const paidRestDays = Number(bigMath.multiply(daysWorked, restDaysMultiplier).toFixed(2));
      const totalDays = daysWorked + paidRestDays;
      const salaryTotal = Number((dailySalary * totalDays).toFixed(2));

      // Horas extra
      const empBonusOvertime = personalBonusOvertime.find((x) => String(x.idEmployee) === employee.id) ?? bonusOvertime;
      const extraHours = Number(sumField(empOvertimeRecords, "hours").toFixed(2));
      const extraHoursPayment = Number((extraHours * (empBonusOvertime?.value || 0)).toFixed(2));
      let taxableBonuses = 0;
      if (empBonusOvertime?.taxable) taxableBonuses += extraHoursPayment;

      // Bono de asistencia: se anula si existen ausencias (no pagadas)
      const empBonusAttendance =
        personalBonusAttendance.find((x) => String(x.idEmployee) === employee.id) ?? bonusAttendance;
      const attendanceBonus = empAbsences.length > 0 ? 0 : this.evaluateBonus(empBonusAttendance, salaryTotal);
      if ((personalBonusAttendance.find((x) => String(x.idEmployee) === employee.id) ?? bonusAttendance)?.taxable) {
        taxableBonuses += attendanceBonus;
      }

      // Bono de puntualidad: se anula si hay al menos 1 tardanza
      const empBonusPunctuality =
        personalBonusPunctuality.find((x) => String(x.idEmployee) === employee.id) ?? bonusPunctuality;
      const punctualityBonus = employeeTardies.length >= 1 ? 0 : this.evaluateBonus(empBonusPunctuality, salaryTotal);
      if ((personalBonusPunctuality.find((x) => String(x.idEmployee) === employee.id) ?? bonusPunctuality)?.taxable) {
        taxableBonuses += punctualityBonus;
      }

      // Bono de despensa (se aplica a todos los empleados)
      const empBonusGrocery = personalBonusGrocery.find((x) => String(x.idEmployee) === employee.id) ?? bonusGrocery;
      const groceryBonus = this.evaluateBonus(empBonusGrocery, salaryTotal);
      if ((personalBonusGrocery.find((x) => String(x.idEmployee) === employee.id) ?? bonusGrocery)?.taxable) {
        taxableBonuses += groceryBonus;
      }


      // Bono de caseta (solo si el puesto es "Casetero")
      const empBonusShed = employee.job?.name === "Casetero"
        ? personalBonusShed.find((x) => String(x.idEmployee) === employee.id) ?? bonusShed
        : null;
      const shedBonus = this.evaluateBonus(empBonusShed, salaryTotal);
      if (empBonusShed?.taxable) taxableBonuses += shedBonus;

      // Bono de empaque (solo aplica uno: H o M)
      let empBonusPackage: IBonus | IPersonalBonus | null = null;
      let packageBonus = 0;

      if (employee.job?.name === "Empaque H") {
        empBonusPackage =
          personalBonusPackageH.find((x) => String(x.idEmployee) === employee.id) ?? bonusPackageH;
      } else if (employee.job?.name === "Empaque M") {
        empBonusPackage =
          personalBonusPackageM.find((x) => String(x.idEmployee) === employee.id) ?? bonusPackageM;
      }

      if (empBonusPackage) {
        packageBonus = this.evaluateBonus(empBonusPackage, salaryTotal);
        if (empBonusPackage.taxable) taxableBonuses += packageBonus;
      }



      // Bono por "Festivo Trabajado": se suma el salario diario por cada ausencia con ese motivo.
      const festivoTrabajadoBonus = empAbsences
        .filter((a) => a.reason === "Festivo Trabajado")
        .reduce((prev, curr) => prev + dailySalary, 0);

      // Otros bonos personalizados (si existiesen; en este ejemplo se omite si no hay datos)
      const customBonusesAmounts: { amount: number; taxable: boolean }[] = [];
      const customBonusesTotal = Number(sumField(customBonusesAmounts, "amount").toFixed(2));

      //! Este parece que no se usa, revisar si es necesario...
      const taxPay = Number(
        (
          salaryTotal +
          extraHoursPayment +
          attendanceBonus +
          punctualityBonus +
          festivoTrabajadoBonus +
          taxableBonuses +
          sumField(
            customBonusesAmounts.filter((x) => x.taxable),
            "amount"
          )
        ).toFixed(2)
      );

      const netPay = Number(
        (
          salaryTotal +
          extraHoursPayment +
          attendanceBonus +
          punctualityBonus +
          festivoTrabajadoBonus +
          shedBonus +
          packageBonus +
          taxableBonuses +
          customBonusesTotal
        ).toFixed(2)
      );

      lines.push({
        rowIndex: index + 1,
        employeeId: employee.id,
        employeeName: employeeFullName,
        jobId: employee.jobId,
        jobName: employee.job ? employee.job.name : "",
        departmentId: employee.departmentId,
        clabe,
        mxCurp: curp,
        mxNss: nss,
        dailySalary,
        daysWorked,
        paidRestDays,
        totalDays,
        salary: salaryTotal,
        extraHours,
        extraHoursPayment,
        punctualityBonus,
        attendanceBonus,
        groceryBonus,
        packageBonus,
        shedBonus,
        holidayBonus: festivoTrabajadoBonus,
        customBonusesTotal: customBonusesTotal || undefined,
        netPay,
        jobScheme,
      });

      customLogColored(
        `Empleado: ${employeeFullName} – Días trabajados: ${daysWorked}, Sueldo base: $${salaryTotal.toFixed(
          2
        )}, Bono Festivo Trabajado: $${festivoTrabajadoBonus.toFixed(2)}`,
        "yellow"
      );
    }

    // Crear o actualizar el registro de nómina
    let record = await PayrollModel.findOne({ active: true, startDate: formattedWeekStartDate }, null, { session });
    if (record) {
      record.lines = lines;
      record.name = `Nómina del ${formatDate(weekStartDate)} al ${formatDate(weekCutoffDate)}`;
    } else {
      const payrollId = "PR" + String(await consumeSequence("payrolls", session)).padStart(8, "0");
      record = new PayrollModel({
        id: payrollId,
        name: `Nómina del ${formatDate(weekStartDate)} al ${formatDate(weekCutoffDate)}`,
        lines,
        startDate: formattedWeekStartDate,
        cutoffDate: formattedWeekCutoffDate,
      });
    }
    await record.save({ session });
    customLogColored(`Nómina guardada con id ${record.id}`, "green");
    return record;
  }

  /**
   * Calcula el monto de un bono según su tipo (monto fijo o porcentaje).
   */
  evaluateBonus(bonus: IBonus | IPersonalBonus | null, salary: number): number {
    if (!bonus || bonus.value == null) return 0;
    if (bonus.type === BonusType.AMOUNT) return Number(bonus.value.toFixed(2));
    if (bonus.type === BonusType.PERCENT) return Number(((bonus.value / 100) * salary).toFixed(2));
    return 0;
  }

  /**
   * Genera el reporte Excel de la nómina.
   */
  async excelReport(query: any): Promise<{ file: Buffer; fileName: string }> {
    const payrollId = query.id;
    if (payrollId == null) throw new AppErrorResponse({ statusCode: 400, name: "El id es requerido" });
    const payroll = await PayrollModel.findOne({ active: true, id: payrollId });
    if (payroll == null) throw new AppErrorResponse({ statusCode: 404, name: "No se encontró el pago de nómina" });

    // Consultar datos de empleados, departamentos y puestos
    const employeeIds = payroll.lines.map((x: any) => x.employeeId);
    const employeesArr = await EmployeeModel.find({ id: { $in: employeeIds } });
    const employees = employeesArr.reduce((acc: any, emp) => {
      acc[emp.id] = emp;
      return acc;
    }, {});
    const departmentIds = [...new Set(payroll.lines.map((x: any) => x.departmentId))];
    const departmentsArr = await DepartmentModel.find({ id: { $in: departmentIds } });
    const departments = departmentsArr.reduce((acc: any, dep) => {
      acc[dep.id] = dep;
      return acc;
    }, {});
    const jobIds = [...new Set(payroll.lines.map((x: any) => x.jobId))];
    const jobsArr = await JobModel.find({ id: { $in: jobIds } });
    const jobs = jobsArr.reduce((acc: any, job) => {
      acc[job.id] = job;
      return acc;
    }, {});

    // Preparar filas para el Excel
    const rowsArray = payroll.lines.map((line: any) => {
      const emp = employees[line.employeeId];
      return {
        idBio: emp ? emp.biometricId : "",
        employeeName: emp ? getEmployeeFullName(emp) : "",
        jobName: jobs[line.jobId]?.name ?? "",
        clabe: emp ? emp.bankAccountNumber || "" : "",
        mxCurp: emp ? emp.mxCurp || "" : "",
        mxNss: emp ? emp.mxNss || "" : "",
        dailySalary: line.dailySalary,
        daysWorked: line.daysWorked,
        paidRestDays: line.paidRestDays,
        totalDays: line.totalDays,
        salary: line.salary,
        extraHours: line.extraHours,
        extraHoursPayment: line.extraHoursPayment,
        punctualityBonus: line.punctualityBonus,
        attendanceBonus: line.attendanceBonus,
        groceryBonus: line.groceryBonus,
        packageBonus: line.packageBonus,
        shedBonus: line.shedBonus,
        holidayBonus: line.holidayBonus,
        customBonusesTotal: Number(line.customBonusesTotal) !== 0 ? line.customBonusesTotal : undefined,
        netPay: line.netPay,
        departmentId: line.departmentId,
      };
    });

    // Agrupar filas por departamento
    const rowsByDept: { [depName: string]: any[] } = {};
    for (const row of rowsArray) {
      const depName = departments[row.departmentId]?.name || "Sin Departamento";
      if (!rowsByDept[depName]) rowsByDept[depName] = [];
      rowsByDept[depName].push(row);
    }

    const workbook = new ExcelJS.Workbook();
    const borderStyle: Partial<ExcelJS.Borders> = {
      top: { style: "thin", color: { argb: "AAAAAA" } },
      left: { style: "thin", color: { argb: "AAAAAA" } },
      bottom: { style: "thin", color: { argb: "AAAAAA" } },
      right: { style: "thin", color: { argb: "AAAAAA" } },
    };
    const headerFill: ExcelJS.Fill = { type: "pattern", pattern: "solid", fgColor: { argb: "DCE6F1" } };

    // Crear hojas por departamento
    for (const [depName, rowArray] of Object.entries(rowsByDept)) {
      const worksheet = workbook.addWorksheet(depName, { views: [{ state: "frozen", ySplit: 1 }] });
      const columns = [
        { header: "ID Empleado", key: "idBio", width: 20, style: { numFmt: "@" } },
        { header: "Nombre del empleado", key: "employeeName", width: 30, style: { numFmt: "@" } },
        { header: "Puesto", key: "jobName", width: 15, style: { numFmt: "@" } },
        { header: "Cuenta CLABE", key: "clabe", width: 20, style: { numFmt: "@" } },
        { header: "CURP", key: "mxCurp", width: 20, style: { numFmt: "@" } },
        { header: "NSS", key: "mxNss", width: 20, style: { numFmt: "@" } },
        { header: "Salario Diario", key: "dailySalary", width: 15, style: { numFmt: '"$"#,##0.00' } },
        { header: "Días Trabajados", key: "daysWorked", width: 11, style: { numFmt: "0" } },
        { header: "Parte Proporcional", key: "paidRestDays", width: 20, style: { numFmt: "0.00" } },
        { header: "Días a Pagar", key: "totalDays", width: 10, style: { numFmt: "0.00" } },
        { header: "Sueldo", key: "salary", width: 15, style: { numFmt: '"$"#,##0.00' } },
        { header: "Horas Extra", key: "extraHours", width: 10, style: { numFmt: "0.00" } },
        { header: "Pago Horas Extra", key: "extraHoursPayment", width: 15, style: { numFmt: '"$"#,##0.00' } },
        { header: "Bono Puntualidad", key: "punctualityBonus", width: 15, style: { numFmt: '"$"#,##0.00' } },
        { header: "Bono Asistencia", key: "attendanceBonus", width: 15, style: { numFmt: '"$"#,##0.00' } },
        { header: "Bono de Empaque", key: "packageBonus", width: 15, style: { numFmt: '"$"#,##0.00' } },
        { header: "Bono de Caseta", key: "shedBonus", width: 15, style: { numFmt: '"$"#,##0.00' } },
        { header: "Despensa", key: "groceryBonus", width: 15, style: { numFmt: '"$"#,##0.00' } },
        { header: "Bono Festivo Trabajado", key: "holidayBonus", width: 15, style: { numFmt: '"$"#,##0.00' } },
        // La columna "Otros Bonos" se incluye solo si alguno de sus valores es mayor que cero
        { header: "Otros Bonos", key: "customBonusesTotal", width: 15, style: { numFmt: '"$"#,##0.00' } },
        { header: "Total a Pagar", key: "netPay", width: 15, style: { numFmt: '"$"#,##0.00' } },
      ];
      // Verificar si se debe eliminar "Otros Bonos"
      const includeCustom = rowArray.some((row) => Number(row.customBonusesTotal) > 0);
      if (!includeCustom) {
        // Se elimina la columna "Otros Bonos"
        const indexToRemove = columns.findIndex((col) => col.key === "customBonusesTotal");
        if (indexToRemove > -1) {
          columns.splice(indexToRemove, 1);
        }
      }
      worksheet.columns = columns;

      const headerRow = worksheet.getRow(1);
      headerRow.eachCell((cell) => {
        cell.fill = headerFill;
        cell.border = borderStyle;
        cell.alignment = { horizontal: "center", vertical: "middle" };
        cell.font = { bold: true };
      });

      for (const row of rowArray) {
        const filteredRow = worksheet.columns.reduce((acc: any, col) => {
          if (row.hasOwnProperty(col.key)) {
            if (col.key) {
              acc[col.key] = row[col.key];
            }
          }
          return acc;
        }, {});
        worksheet.addRow(filteredRow);
      }

      const lastRowNum = worksheet.rowCount;
      const totalsRow = worksheet.addRow({
        idBio: "Totales",
        salary: {
          formula: `SUM(${worksheet.getColumn("salary").letter}2:${worksheet.getColumn("salary").letter}${lastRowNum})`,
        },
        extraHours: {
          formula: `SUM(${worksheet.getColumn("extraHours").letter}2:${worksheet.getColumn("extraHours").letter
            }${lastRowNum})`,
        },
        extraHoursPayment: {
          formula: `SUM(${worksheet.getColumn("extraHoursPayment").letter}2:${worksheet.getColumn("extraHoursPayment").letter
            }${lastRowNum})`,
        },
        punctualityBonus: {
          formula: `SUM(${worksheet.getColumn("punctualityBonus").letter}2:${worksheet.getColumn("punctualityBonus").letter
            }${lastRowNum})`,
        },
        attendanceBonus: {
          formula: `SUM(${worksheet.getColumn("attendanceBonus").letter}2:${worksheet.getColumn("attendanceBonus").letter
            }${lastRowNum})`,
        },
        packageBonus: {
          formula: `SUM(${worksheet.getColumn("packageBonus").letter}2:${worksheet.getColumn("packageBonus").letter
            }${lastRowNum})`,
        },
        shedBonus: {
          formula: `SUM(${worksheet.getColumn("shedBonus").letter}2:${worksheet.getColumn("shedBonus").letter
            }${lastRowNum})`,
        },
        groceryBonus: {
          formula: `SUM(${worksheet.getColumn("groceryBonus").letter}2:${worksheet.getColumn("groceryBonus").letter
            }${lastRowNum})`,
        },
        holidayBonus: {
          formula: `SUM(${worksheet.getColumn("holidayBonus").letter}2:${worksheet.getColumn("holidayBonus").letter
            }${lastRowNum})`,
        },
        ...(includeCustom && {
          customBonusesTotal: {
            formula: `SUM(${worksheet.getColumn("customBonusesTotal").letter}2:${worksheet.getColumn("customBonusesTotal").letter
              }${lastRowNum})`,
          },
        }),
        netPay: {
          formula: `SUM(${worksheet.getColumn("netPay").letter}2:${worksheet.getColumn("netPay").letter}${lastRowNum})`,
        },
      });
      totalsRow.eachCell({ includeEmpty: true }, (cell) => {
        cell.font = { bold: true };
        cell.border = {
          top: { style: "thick", color: { argb: "000000" } },
          left: { style: "thin", color: { argb: "AAAAAA" } },
          bottom: { style: "thin", color: { argb: "AAAAAA" } },
          right: { style: "thin", color: { argb: "AAAAAA" } },
        };
        cell.alignment = { horizontal: "center", vertical: "middle" };
      });
    }

    // Hoja de resumen
    const summaryData = Object.keys(rowsByDept).map((depName) => {
      const rows = rowsByDept[depName];
      const totalEmployees = rows.length;
      const totalAmount = Number(rows.reduce((sum: number, row: any) => sum + Number(row.netPay), 0).toFixed(2));
      return { departmentName: depName, totalEmployees, totalAmount };
    });
    const summarySheet = workbook.addWorksheet("Resumen");
    summarySheet.columns = [
      { header: "Departamento", key: "departmentName", width: 20 },
      { header: "Empleados", key: "totalEmployees", width: 15 },
      { header: "Cantidad a Pagar", key: "totalAmount", width: 20, style: { numFmt: '"$"#,##0.00' } },
    ];
    const headerRowSummary = summarySheet.getRow(1);
    headerRowSummary.eachCell((cell) => {
      cell.fill = headerFill;
      cell.border = borderStyle;
      cell.alignment = { horizontal: "center", vertical: "middle" };
      cell.font = { bold: true };
    });
    summaryData.forEach((row) => summarySheet.addRow(row));
    const totalSummaryRow = summarySheet.addRow({
      departmentName: "TOTAL =",
      totalEmployees: { formula: `SUM(B2:B${summarySheet.rowCount})` },
      totalAmount: { formula: `SUM(C2:C${summarySheet.rowCount})` },
    });
    totalSummaryRow.font = { bold: true };
    totalSummaryRow.eachCell((cell) => {
      cell.border = { top: { style: "thin" }, bottom: { style: "double" } };
    });

    const excelBuffer = (await workbook.xlsx.writeBuffer()) as unknown as Buffer;
    return { file: excelBuffer, fileName: `${payroll.name || "Nomina"}.xlsx` };
  }
}

const payrollService: PayrollService = new PayrollService();
export default payrollService;
