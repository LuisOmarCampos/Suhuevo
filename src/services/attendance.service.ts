/* lib */
import moment from "moment";
import { ClientSession } from "mongoose";
/* models */
import { ScheduleExceptionModel } from "@app/repositories/mongoose/models/schedule-exception.model";
import { AttendanceModel } from "@app/repositories/mongoose/models/attendance.model";
import { EmployeeModel } from "@app/repositories/mongoose/models/employee.model";
import { AbsenceModel } from "@app/repositories/mongoose/models/absence.model";
import { AppErrorResponse } from "@app/models/app.response";
/* services */
import overtimeService from "./overtime.service";
/* utils */
import { consumeSequence } from "@app/utils/sequence";
import { customLog } from "@app/utils/util.util";
import { readCsv } from "@app/utils/file.util";
/* dtos */
import { AppMainMongooseRepo } from "@app/repositories/mongoose";
import { CreateAttendanceBody, CreateAttendanceResponse, IAttendance } from "@app/dtos/attendance.dto";
import { EEmployeeAttendanceScheme, EEmployeStatus, IEmployeSchedule } from "@app/dtos/employee.dto";
import { FestiveWorkModel } from "@app/repositories/mongoose/models/festive-work.model";


class AttendanceService {
  private readonly MAX_TIME_DELAY = 15;
  private readonly notWorkableScheduleExceptions = ["Permiso sin Sueldo", "Permiso con Sueldo", "Vacaciones", "Festivo", "Festivo Trabajado"];
  private readonly daysTranslationMap: { [key: string]: string } = {
    monday: "lunes",
    tuesday: "martes",
    wednesday: "miércoles",
    thursday: "jueves",
    friday: "viernes",
    saturday: "sábado",
    sunday: "domingo",
  };

  // Retorna el rango de semana (de miércoles a martes siguiente) basado en la fecha dada.
  private getWeekRange(date: moment.Moment): { weekStart: moment.Moment; weekEnd: moment.Moment } {
    const weekday = date.isoWeekday(); // Monday=1, Tuesday=2, Wednesday=3, etc.
    let weekStart: moment.Moment;
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

  // Métodos básicos: get, search, update, reformatData
  public async get(query: any): Promise<any> {
    const ids = Array.isArray(query.ids) ? query.ids : [query.ids];
    const records = await AttendanceModel.find({ active: true, id: { $in: ids } });
    const result: any = {};
    for (const record of records) {
      result[record.id] = record;
    }
    return result;
  }

  public async search(query: any): Promise<any> {
    const { limit = 100, size, ...queryFields } = query;
    const allowedFields: (keyof IAttendance)[] = ["id", "employeeId", "checkInTime", "isLate"];
    const filter: any = { active: true };
    const selection: any = size === "small" ? {} : { active: 0, _id: 0, __v: 0 };
    for (const field in queryFields) {
      const cleanField = field.replace(/[~<>]/, "");
      if (!allowedFields.includes(cleanField as keyof IAttendance)) {
        throw new AppErrorResponse({ statusCode: 403, name: `Campo no permitido: ${field}` });
      }
      const value = queryFields[field];
      if (Array.isArray(value)) {
        filter[cleanField] = { $in: value };
      } else if (field.startsWith("~")) {
        filter[cleanField] = new RegExp(String(value).replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "i");
      } else if (field.startsWith("<")) {
        filter[cleanField] = { $lt: value };
      } else if (field.startsWith(">")) {
        filter[cleanField] = { $gt: value };
      } else {
        filter[cleanField] = value;
      }
    }
    const records = await AttendanceModel.find(filter).select(selection).limit(limit).sort({ createdAt: "desc" });
    if (records.length === 0) return [];
    return this.reformatData(records);
  }

  public async update(body: any): Promise<any> {
    const record = await AttendanceModel.findOne({ id: body.id });
    if (!record) throw new AppErrorResponse({ statusCode: 404, name: "No se encontró la asistencia" });
    const allowedFields: (keyof IAttendance)[] = ["isLate"];
    for (const field of allowedFields) {
      if (body[field] !== undefined) {
        (record as any)[field] = body[field];
      }
    }
    await record.save();
    customLog(`Actualizada asistencia ${record.id}`);
    return { id: record.id };
  }

  public async reformatData(array: IAttendance[]): Promise<any[]> {
    return array.map((record: IAttendance) => ({
      ...JSON.parse(JSON.stringify(record)),
      date: record.checkInTime,
      title: record.isLate ? "Retardo" : "Asistencia",
    }));
  }

  // create: Procesa un único registro individual.
  public async create(body: CreateAttendanceBody): Promise<CreateAttendanceResponse> {
    const { employeeId, checkInTime: checkInTimeStr, checkOutTime: checkOutTimeStr } = body;
    const checkInTime = moment(checkInTimeStr);
    const checkOutTime = checkOutTimeStr ? moment(checkOutTimeStr) : null;
    const day = checkInTime.clone().format("YYYY-MM-DD");

    const employee = await EmployeeModel.findOne({
      $or: [{ id: employeeId }, { biometricId: employeeId }],
      status: EEmployeStatus.ACTIVE,
      active: true,
    });
    if (!employee) throw new AppErrorResponse({ statusCode: 404, name: `No se encontró el empleado ${employeeId}` });
    const employeeName = employee.fullname();

    const existingAttendance = await AttendanceModel.findOne({
      active: true,
      employeeId: employee.id,
      checkInTime: { $regex: `^${day}` },
    });
    if (existingAttendance)
      throw new AppErrorResponse({ statusCode: 409, name: `Ya hay una asistencia para ${employeeName} el día ${day}` });
    const existingAbsence = await AbsenceModel.findOne({
      active: true,
      employeeId: employee.id,
      date: { $regex: `^${day}` },
    });
    if (existingAbsence)
      throw new AppErrorResponse({ statusCode: 409, name: `Ya hay una ausencia para ${employeeName} el día ${day}` });

    const dayOfWeek = checkInTime.format("dddd").toLowerCase();
    const scheduleForDay = employee.schedule ? employee.schedule[dayOfWeek as keyof IEmployeSchedule] : null;
    const scheduleException = await ScheduleExceptionModel.findOne({
      active: true,
      employeeId: employee.id,
      name: { $nin: this.notWorkableScheduleExceptions },
      $or: [
        { $and: [{ startDate: { $regex: `^${day}` } }, { allDay: true }] },
        {
          $and: [
            { startDate: { $lte: day } },
            {
              $or: [
                { endDate: { $gt: day } },
                { endDate: "" },
                { endDate: null },
                { endDate: { $exists: false } }
              ],
            },
          ],
        },
      ],
    });

    if ((!scheduleForDay || !scheduleForDay.start) && !scheduleException) {
      throw new AppErrorResponse({
        statusCode: 400,
        name: `${employeeName} no trabaja el día ${day} (${this.daysTranslationMap[dayOfWeek]})`,
      });
    }
    const defaultSchedule = Object.values(employee.schedule).find((x) => x?.start && x?.end);
    const scheduleForDayStart = scheduleForDay?.start ?? defaultSchedule?.start;
    const scheduleForDayEnd = scheduleForDay?.end ?? defaultSchedule?.end;
    if (!scheduleForDayStart || !scheduleForDayEnd) {
      throw new AppErrorResponse({ statusCode: 400, name: `No se encontró un horario válido para ${employeeName}` });
    }
    const scheduleStartTime = moment(`${day}T${scheduleForDayStart}:00`);
    const scheduleEndTime = moment(`${day}T${scheduleForDayEnd}:00`);

    const delayMinutes = checkInTime.diff(scheduleStartTime, "minutes");
    let overtimeMinutes = 0;
    if (checkOutTime) {
      overtimeMinutes = checkOutTime.diff(scheduleEndTime, "minutes");
      overtimeMinutes = overtimeMinutes > 0 ? overtimeMinutes : 0;
    }
    const isLate = delayMinutes > this.MAX_TIME_DELAY;

    if (checkOutTime) {
      const id = "AT" + String(await consumeSequence("attendances")).padStart(8, "0");
      const late = checkInTime.isAfter(moment(`${day}T${scheduleForDay?.start}:00`));
      const attendanceRecord = new AttendanceModel({
        id,
        employeeId: employee.id,
        employeeName,
        checkInTime: checkInTime.format("YYYY-MM-DD HH:mm:ss"),
        checkOutTime: checkOutTime.format("YYYY-MM-DD HH:mm:ss"),
        date: day,
        isLate,
      });
      customLog(
        `Creando asistencia ${id} para ${employeeName} el día ${day} (CheckIn: ${checkInTime.format(
          "HH:mm:ss"
        )}, CheckOut: ${checkOutTime.format("HH:mm:ss")})`
      );
      await attendanceRecord.save();
      customLog(`Asistencia ${id} registrada para ${employeeName}`);

      // ✅ Si es Festivo Trabajado → crear ausencia adicional pagada
      // Si es Festivo Trabajado → crear registro en FestiveWorkModel
      if (scheduleException?.name === "Festivo Trabajado") {
        const festiveWorkId = "FW" + String(await consumeSequence("festiveWork")).padStart(8, "0");
        const festiveRecord = new FestiveWorkModel({
          id: festiveWorkId,
          employeeId: employee.id,
          employeeName,
          date: day,
        });
        await festiveRecord.save();
        customLog(`🎉 Se creó registro de Festivo Trabajado (${festiveWorkId}) para ${employeeName}`);
      }
      // Procesar tiempo extra: se crea una sesión específica para la creación de tiempo extra.
      if (
        employee.overtimeAllowed &&
        overtimeMinutes >= employee.minOvertimeMinutes &&
        employee.minOvertimeMinutes > 0
      ) {
        const otSession = await AppMainMongooseRepo.startSession();
        try {
          otSession.startTransaction();
          await overtimeService.create(
            {
              employeeId: employee.id,
              startTime: scheduleEndTime.format("YYYY-MM-DD HH:mm:ss"),
              hours: Math.floor(overtimeMinutes / 60),
            },
            otSession
          );
          await otSession.commitTransaction();
          customLog(`Tiempo extra creado para ${employeeName}`);
        } catch (error: unknown) {
          if (error instanceof Error) {
            console.error("Error en overtime create:", error.message);
          } else {
            console.error("Error en overtime create:", String(error));
          }
          await otSession.abortTransaction();
        } finally {
          otSession.endSession();
        }
      }
      return { id: attendanceRecord.id };
    } else {
      if (employee.attendanceScheme === EEmployeeAttendanceScheme.AUTOMATIC) {
        const autoCheckOutTime = scheduleEndTime;
        const id = "AT" + String(await consumeSequence("attendances")).padStart(8, "0");
        const attendanceRecord = new AttendanceModel({
          id,
          employeeId: employee.id,
          employeeName,
          checkInTime: checkInTime.format("YYYY-MM-DD HH:mm:ss"),
          checkOutTime: autoCheckOutTime.format("YYYY-MM-DD HH:mm:ss"),
          date: day,
          isLate,
        });
        customLog(
          `Creando asistencia automática ${id} para ${employeeName} el día ${day} (CheckIn: ${checkInTime.format(
            "HH:mm:ss"
          )}, CheckOut: ${autoCheckOutTime.format("HH:mm:ss")})`
        );
        await attendanceRecord.save();
        customLog(`Asistencia automática ${id} registrada para ${employeeName}`);
        return { id: attendanceRecord.id };
      } else {
        let reason = "No se hizo el check out";
        let paidValue = 1;
        let isPaid = false;
        let isJustified = false;

        if (scheduleException) {
          isJustified = true;
          switch (scheduleException.name) {
            case "Permiso con Sueldo":
              reason = "Permiso con goce de sueldo";
              isPaid = true;
              paidValue = 1;
              break;
            case "Permiso sin Sueldo":
              reason = "Permiso sin goce de sueldo";
              isPaid = false;
              paidValue = 0;
              break;
            case "Vacaciones":
              reason = "Vacaciones";
              isPaid = true;
              paidValue = 1;
              break;
            case "Festivo":
              reason = "Festivo";
              isPaid = true;
              paidValue = 1;
              break;
            default:
              reason = scheduleException.reason || "Falta Justificada";
              isPaid = true;
              paidValue = 1;
          }
        } else {
          // Ausencia normal sin excepción
          isJustified = false;
          isPaid = false;
          paidValue = 0;
        }

        const id = "AB" + String(await consumeSequence("absences")).padStart(8, "0");
        const absenceRecord = new AbsenceModel({
          id,
          employeeId: employee.id,
          employeeName,
          date: day,
          reason,
          isPaid,
          paidValue,
          isJustified,
        });
        customLog(`Creando ausencia ${id} para ${employeeName} el día ${day} (${reason})`);
        await absenceRecord.save();
        customLog(`Ausencia ${id} registrada para ${employeeName}`);
        return { id };
      }
    }
  }

  // importFromCsv: Procesa el CSV completo sin una transacción global.
  public async importFromCsv(file: Express.Multer.File | undefined): Promise<any> {
    /* si no llega archivo lanza error */
    if (!file) {
      throw new AppErrorResponse({ statusCode: 400, name: "El archivo CSV es requerido" });
    }
    /* lectura de csv */
    customLog("Iniciando lectura del CSV...");
    const csvRows = await readCsv(file);

    /* si e csv no tiene registros lanza error */
    if (!csvRows || csvRows.length === 0) {
      throw new AppErrorResponse({ statusCode: 400, name: "El archivo CSV no contiene registros válidos" });
    }
    customLog(`CSV leído: ${csvRows.length} filas encontradas.`);

    // Ordenar por empleado y por fecha/hora.
    csvRows.sort((a, b) => {
      const cmp = a.employeeId.localeCompare(b.employeeId);
      if (cmp !== 0) return cmp;
      const timeA = moment(a.time, "DD/MM/YYYY HH:mm");
      const timeB = moment(b.time, "DD/MM/YYYY HH:mm");
      return timeA.diff(timeB);
    });
    customLog("CSV ordenado por empleado y tiempo.");

    // Determinar el rango de semana a procesar basado en la fecha mínima del CSV.
    const allDates = csvRows.map((row) => moment(row.time, "DD/MM/YYYY HH:mm")).filter((m) => m.isValid());

    // si no hay fechas válidas mandar error
    if (allDates.length === 0) {
      throw new AppErrorResponse({ statusCode: 400, name: "No se encontraron fechas válidas en el CSV" });
    }

    // obtener fecha mínima (primer fecha en el registro)
    const minDate = moment.min(allDates);
    const { weekStart, weekEnd } = this.getWeekRange(minDate);
    customLog(`Semana a procesar: ${weekStart.format("YYYY-MM-DD")} a ${weekEnd.format("YYYY-MM-DD")}`);

    // Agrupar registros CSV por empleado y por día.
    const csvDataByEmployee: { [empId: string]: { [day: string]: moment.Moment[] } } = {};
    for (const row of csvRows) {
      const m = moment(row.time, "DD/MM/YYYY HH:mm");
      if (!m.isValid()) continue;
      if (!m.isBetween(weekStart, weekEnd, undefined, "[]")) continue;
      const dayStr = m.format("YYYY-MM-DD");
      const empId = String(row.employeeId).trim();
      if (!csvDataByEmployee[empId]) csvDataByEmployee[empId] = {};
      if (!csvDataByEmployee[empId][dayStr]) {
        csvDataByEmployee[empId][dayStr] = [];
      }
      csvDataByEmployee[empId][dayStr].push(m);
    }

    // Ordenar cada conjunto de registros.
    for (const empId in csvDataByEmployee) {
      for (const day in csvDataByEmployee[empId]) {
        csvDataByEmployee[empId][day].sort((a, b) => a.diff(b));
      }
    }
    customLog("Registros CSV agrupados por empleado y día.");

    // Consultar empleados activos y registros existentes para el rango.
    const employees = await EmployeeModel.find({ active: true, status: EEmployeStatus.ACTIVE });
    const existingAttendances = await AttendanceModel.find({
      active: true,
      date: { $gte: weekStart.format("YYYY-MM-DD"), $lte: weekEnd.format("YYYY-MM-DD") },
    });
    const existingAbsences = await AbsenceModel.find({
      active: true,
      date: { $gte: weekStart.format("YYYY-MM-DD"), $lte: weekEnd.format("YYYY-MM-DD") },
    });
    const scheduleExceptions = await ScheduleExceptionModel.find({
      active: true,
      name: { $in: this.notWorkableScheduleExceptions },
      $or: [
        { $and: [{ startDate: { $regex: `^${weekStart.format("YYYY-MM-DD")}` } }, { allDay: true }] },
        {
          $and: [
            { startDate: { $lte: weekEnd.format("YYYY-MM-DD") } },
            {
              $or: [
                { endDate: { $gt: weekEnd.format("YYYY-MM-DD") } },
                { endDate: { $eq: "" } }
              ]
            }
          ]
        }
      ]
    });
    console.log(`Empleados activos encontrados: ${employees.length}`);
    console.log(`Asistencias existentes encontradas: ${existingAttendances.length}`);
    console.log(`Ausencias existentes encontradas: ${existingAbsences.length}`);
    console.log(`Excepciones de horario encontradas: ${scheduleExceptions.length}`);

    let automaticAttendanceCount = 0; // variable para conteo de asistencias automáticas
    let newAttendanceCount = 0; // variable para conteo de asistencias generales
    let newAbsenceCount = 0; // variable de conteo de ausencias
    const detail: string[] = [];
    const overtimeRequests: {
      employeeId: string;
      scheduleEndTime: moment.Moment;
      overtimeMinutes: number;
      employee?: any;
    }[] = [];

    // Arreglo de días a procesar.
    const daysInRange: string[] = [];
    let current = weekStart.clone();
    while (current.isSameOrBefore(weekEnd, "day")) {
      daysInRange.push(current.format("YYYY-MM-DD"));
      current.add(1, "day");
    }
    customLog(`Días a procesar en la semana: ${daysInRange.join(", ")}`);

    // Hasta aquí el flujo va todo bien.
    // Procesar cada empleado y cada día.
    for (const employee of employees) {
      const employeeName = employee.fullname();
      let empCsvData = csvDataByEmployee[employee.id];
      if (typeof empCsvData === "undefined" && employee.biometricId) {
        empCsvData = csvDataByEmployee[employee.biometricId];
      }
      for (const dayStr of daysInRange) {
        customLog(`Procesando ${employeeName} para el día ${dayStr}`);

        // Verificar si ya existe registro de asistencias.
        const findAttendances = existingAttendances.find((a) => {
          return a.employeeId === employee.id && a.date === dayStr && a.checkOutTime && a.checkOutTime.trim() !== "";
        });
        // en caso de ya tener asistencia se hace un push a los detalles
        if (typeof findAttendances !== "undefined") {
          detail.push(`${employeeName} ya tiene asistencia completa para ${dayStr}`);
          customLog(`${employeeName} ya tiene asistencia completa para ${dayStr}`);
          continue;
        }

        // Verificar si ya existe registro de ausencias.
        const findAbsences = existingAbsences.find((a) => a.employeeId === employee.id && a.date === dayStr);
        // en caso de ya tener ausencia se hace un push a los detalles
        if (typeof findAbsences !== "undefined") {
          detail.push(`${employeeName} ya tiene ausencia registrada para ${dayStr}`);
          customLog(`${employeeName} ya tiene ausencia registrada para ${dayStr}`);
          continue;
        }

        // obtengo el nombre del día en minúsculas
        const currentDayOfWeek = moment(dayStr, "YYYY-MM-DD").format("dddd").toLowerCase();
        // búsqueda de horario del empleado y en caso de no tener regresa null
        const scheduleForDay = employee.schedule ? employee.schedule[currentDayOfWeek as keyof IEmployeSchedule] : null;

        // verificación extra para ver que tenga los campos necesarios en el horario del empleado
        if (scheduleForDay == null || !scheduleForDay.start || !scheduleForDay.end) {
          detail.push(`No hay horario definido para ${employeeName} en ${currentDayOfWeek} (${dayStr})`);
          customLog(`No hay horario definido para ${employeeName} en ${currentDayOfWeek} (${dayStr})`);
          continue;
        }
        // variables de inicio y fin de horario del respectivo día
        const scheduleStartTime = moment(`${dayStr}T${scheduleForDay.start}:00`);
        const scheduleEndTime = moment(`${dayStr}T${scheduleForDay.end}:00`);

        // Determinar tiempos efectivos.
        let effectiveCheckIn: moment.Moment;
        let effectiveCheckOut: moment.Moment | null = null;
        let csvDataForDay: { checkInTime: string; checkOutTime?: string } | undefined;

        // revisa si el usuario se encuentra en los registros del csv que se definió al inicio del método en empCsvData
        if (typeof empCsvData !== "undefined" && empCsvData[dayStr] && empCsvData[dayStr].length > 0) {
          const times = empCsvData[dayStr];
          effectiveCheckIn = times[0];
          // en caso haya varios registros el mismo día, verifica que haya diferencia de 60 minutos entre un registro y otro para tomarlo en cuanta como checkOut
          if (times.length > 1 && times[times.length - 1].diff(times[0], "minutes") >= 60) {
            effectiveCheckOut = times[times.length - 1];
          }

          // objeto con checkIn y checkOut del día
          csvDataForDay = {
            checkInTime: effectiveCheckIn.format("YYYY-MM-DD HH:mm:ss"),
            checkOutTime: effectiveCheckOut ? effectiveCheckOut.format("YYYY-MM-DD HH:mm:ss") : undefined,
          };
        } else {
          // revisión de si el esquema de horario es automático o manual (por checador)
          if (employee.attendanceScheme === EEmployeeAttendanceScheme.AUTOMATIC) {
            // en caso de que sea automático toma el horario registrado en el empleado
            effectiveCheckIn = moment(`${dayStr}T${scheduleForDay.start}:00`);
            effectiveCheckOut = moment(`${dayStr}T${scheduleForDay.end}:00`);
          } else {
            // en caso manual almacena en checkIn el horario registrado en el empleado
            effectiveCheckIn = moment(`${dayStr}T${scheduleForDay.start}:00`);
          }
        }

        let calculatedOvertime = 0; // variable para el tiempo de retardo

        // en caso de haber checkOut
        if (effectiveCheckOut) {
          calculatedOvertime = effectiveCheckOut.diff(scheduleEndTime, "minutes");
          if (calculatedOvertime <= 0) calculatedOvertime = 0;
        }

        // Insertar registro en BD.
        // en caso de que haya información en csvDataForDay que se definió previamente
        if (typeof csvDataForDay !== "undefined") {
          // en caso de que el objeto cuente con un checkOut
          if (csvDataForDay.checkOutTime) {
            const id = "AT" + String(await consumeSequence("attendances")).padStart(8, "0");
            const late = effectiveCheckIn.isAfter(moment(`${dayStr}T${scheduleForDay.start}:00`));
            const attendanceRecord = new AttendanceModel({
              id,
              employeeId: employee.id,
              employeeName,
              checkInTime: csvDataForDay.checkInTime,
              checkOutTime: csvDataForDay.checkOutTime,
              date: dayStr,
              isLate: late,
            });
            try {
              await attendanceRecord.save();
              newAttendanceCount++;
              detail.push(
                `Se INSERTÓ asistencia ${id} para ${employeeName} en ${dayStr} [CheckIn: ${csvDataForDay.checkInTime
                }, CheckOut: ${csvDataForDay.checkOutTime || "N/A"}]`
              );
              customLog(
                `Se INSERTÓ asistencia ${id} para ${employeeName} en ${dayStr} [CheckIn: ${csvDataForDay.checkInTime
                }, CheckOut: ${csvDataForDay.checkOutTime || "N/A"}]`
              );
              // Verificar si tiene excepción Festivo Trabajado para este día y registrar bono
              const exception = scheduleExceptions.find((se) => {
                if (se.employeeId !== employee.id || se.name !== "Festivo Trabajado") return false;
                const start = moment(se.startDate).startOf("day");
                const end = se.endDate && se.endDate !== "" ? moment(se.endDate).endOf("day") : null;
                const target = moment(dayStr, "YYYY-MM-DD");
                return (
                  (se.allDay && target.isSame(start, "day")) ||
                  (end && target.isSameOrAfter(start, "day") && target.isSameOrBefore(end, "day"))
                );
              });

              if (exception) {
                const festiveWorkId = "FW" + String(await consumeSequence("festiveWork")).padStart(8, "0");
                const festiveRecord = new FestiveWorkModel({
                  id: festiveWorkId,
                  employeeId: employee.id,
                  employeeName,
                  date: dayStr,
                });
                await festiveRecord.save();
                customLog(`🎉 Registro de Festivo Trabajado creado para ${employeeName} (${festiveWorkId})`);
              }
            } catch (error: unknown) {
              if (error instanceof Error) {
                detail.push(`Error al insertar asistencia para ${employeeName} en ${dayStr}: ${error.message}`);
                customLog(`Error al insertar asistencia para ${employeeName} en ${dayStr}: ${error.message}`);
              } else {
                detail.push(`Error al insertar asistencia para ${employeeName} en ${dayStr}: ${String(error)}`);
                customLog(`Error al insertar asistencia para ${employeeName} en ${dayStr}: ${String(error)}`);
              }
              continue;
            }
            if (
              employee.overtimeAllowed &&
              calculatedOvertime >= employee.minOvertimeMinutes &&
              employee.minOvertimeMinutes > 0
            ) {
              overtimeRequests.push({
                employeeId: employee.id,
                scheduleEndTime,
                overtimeMinutes: calculatedOvertime,
                employee,
              });
            }
          } else {
            // CSV incompleto => ausencia.
            let reason = "No se hizo el check out";
            let paidValue = 0;
            let isPaid = false;
            let isJustified = false;

            const id = "AB" + String(await consumeSequence("absences")).padStart(8, "0");
            const absenceRecord = new AbsenceModel({
              id,
              employeeId: employee.id,
              employeeName,
              date: dayStr,
              reason,
              isPaid,
              paidValue,
              isJustified,
            });

            try {
              await absenceRecord.save();
              newAbsenceCount++;
              detail.push(`Se INSERTÓ ausencia ${id} para ${employeeName} en ${dayStr} (${reason})`);
              customLog(`Se INSERTÓ ausencia ${id} para ${employeeName} en ${dayStr} (${reason})`);
            } catch (error: unknown) {
              if (error instanceof Error) {
                detail.push(`Error al insertar ausencia para ${employeeName} en ${dayStr}: ${error.message}`);
                customLog(`Error al insertar ausencia para ${employeeName} en ${dayStr}: ${error.message}`);
              } else {
                detail.push(`Error al insertar ausencia para ${employeeName} en ${dayStr}: ${String(error)}`);
                customLog(`Error al insertar ausencia para ${employeeName} en ${dayStr}: ${String(error)}`);
              }
              continue;
            }
          }
        } else {
          // Sin CSV: según esquema.
          // en caso de no estar en el csv
          // revisa si es de horario automático
          if (employee.attendanceScheme === EEmployeeAttendanceScheme.AUTOMATIC) {
            const autoCheckIn = moment(`${dayStr}T${scheduleForDay.start}:00`);
            const autoCheckOut = moment(`${dayStr}T${scheduleForDay.end}:00`);
            const id = "AT" + String(await consumeSequence("attendances")).padStart(8, "0");
            const attendanceRecord = new AttendanceModel({
              id,
              employeeId: employee.id,
              employeeName,
              checkInTime: autoCheckIn.format("YYYY-MM-DD HH:mm:ss"),
              checkOutTime: autoCheckOut.format("YYYY-MM-DD HH:mm:ss"),
              date: dayStr,
              isLate: false,
            });
            try {
              await attendanceRecord.save();
              newAttendanceCount++;
              automaticAttendanceCount++;
              detail.push(
                `Se INSERTÓ asistencia automática ${id} para ${employeeName} en ${dayStr} (día ${currentDayOfWeek})`
              );
              customLog(
                `Se INSERTÓ asistencia automática ${id} para ${employeeName} en ${dayStr} (día ${currentDayOfWeek})`
              );
            } catch (error: unknown) {
              if (error instanceof Error) {
                detail.push(
                  `Error al insertar asistencia automática para ${employeeName} en ${dayStr}: ${error.message}`
                );
                customLog(
                  `Error al insertar asistencia automática para ${employeeName} en ${dayStr}: ${error.message}`
                );
              } else {
                detail.push(
                  `Error al insertar asistencia automática para ${employeeName} en ${dayStr}: ${String(error)}`
                );
                customLog(
                  `Error al insertar asistencia automática para ${employeeName} en ${dayStr}: ${String(error)}`
                );
              }
              continue;
            }
          } else {
            let reason = "No se hizo el check in";

            let paidValue = 0;
            let isPaid = false;
            let isJustified = false;


            const exception = scheduleExceptions.find((se) => {
              if (se.employeeId !== employee.id) return false;
              const start = moment(se.startDate).startOf("day");
              const end = se.endDate && se.endDate !== "" ? moment(se.endDate).endOf("day") : null;
              const target = moment(dayStr, "YYYY-MM-DD");

              return (
                (se.allDay && target.isSame(start, "day")) ||
                (end && target.isSameOrAfter(start, "day") && target.isSameOrBefore(end, "day"))
              );
            });

            if (exception) {
              console.log(`Excepción encontrada para ${employeeName} en ${dayStr}: ${exception.name}`);
              isJustified = true;
              switch (exception.name) {
                case "Permiso con Sueldo":
                  reason = "Permiso con goce de sueldo";
                  isPaid = true;
                  paidValue = 1;
                  break;
                case "Permiso sin Sueldo":
                  reason = "Permiso sin goce de sueldo";
                  isPaid = false;
                  paidValue = 0;
                  break;
                case "Vacaciones":
                  reason = "Vacaciones";
                  isPaid = true;
                  paidValue = 1;
                  break;
                case "Festivo":
                  reason = "Festivo";
                  isPaid = true;
                  paidValue = 1;
                  break;
                default:
                  reason = exception.reason || "Falta Justificada";
                  isPaid = true;
                  paidValue = 1;
              }
            }


            const id = "AB" + String(await consumeSequence("absences")).padStart(8, "0");
            const absenceRecord = new AbsenceModel({
              id,
              employeeId: employee.id,
              employeeName,
              date: dayStr,
              reason,
              isPaid,
              paidValue,
              isJustified,
            });

            try {
              await absenceRecord.save();
              newAbsenceCount++;
              detail.push(`Se INSERTÓ ausencia ${id} para ${employeeName} en ${dayStr} (${reason})`);
              customLog(`Se INSERTÓ ausencia ${id} para ${employeeName} en ${dayStr} (${reason})`);
            } catch (error: unknown) {
              if (error instanceof Error) {
                detail.push(`Error al insertar ausencia para ${employeeName} en ${dayStr}: ${error.message}`);
                customLog(`Error al insertar ausencia para ${employeeName} en ${dayStr}: ${error.message}`);
              } else {
                detail.push(`Error al insertar ausencia para ${employeeName} en ${dayStr}: ${String(error)}`);
                customLog(`Error al insertar ausencia para ${employeeName} en ${dayStr}: ${String(error)}`);
              }
              continue;
            }
          }
        }
      } // Fin for días
    } // Fin for empleados

    customLog(`Proceso finalizado: ${newAttendanceCount} asistencias y ${newAbsenceCount} ausencias creadas.`);

    // Procesar solicitudes de tiempo extra en forma individual (sin transacción global)
    if (overtimeRequests.length > 0) {
      customLog(`Procesando ${overtimeRequests.length} solicitudes de tiempo extra en operación separada.`);
      for (const req of overtimeRequests) {
        try {
          // Para cada solicitud, se crea una sesión nueva para la creación de tiempo extra.
          const otSession = await AppMainMongooseRepo.startSession();
          otSession.startTransaction();
          await overtimeService.create(
            {
              employeeId: req.employeeId,
              startTime: req.scheduleEndTime.format("YYYY-MM-DD HH:mm:ss"),
              hours: Math.floor(req.overtimeMinutes / 60),
            },
            otSession
          );
          await otSession.commitTransaction();
          customLog(`Tiempo extra creado para ${req.employee?.fullname() || req.employeeId}`);
          otSession.endSession();
        } catch (error: unknown) {
          if (error instanceof Error) {
            if ((error as any).statusCode === 409) {
              customLog(`Tiempo extra duplicado para ${req.employee?.fullname() || req.employeeId}: ${error.message}`);
            } else {
              console.error(
                `Error creando tiempo extra para ${req.employee?.fullname() || req.employeeId}:`,
                error.message
              );
            }
          } else {
            console.error(
              `Error creando tiempo extra para ${req.employee?.fullname() || req.employeeId}:`,
              String(error)
            );
          }
        }
      }
    }
    const resumenPorEmpleado: Record<string, { asistencias: number; ausencias: number; excepciones: number }> = {};

    for (const record of [...existingAttendances, ...existingAbsences, ...scheduleExceptions]) {
      const empId = record.employeeId;
      if (!resumenPorEmpleado[empId]) {
        resumenPorEmpleado[empId] = { asistencias: 0, ausencias: 0, excepciones: 0 };
      }
      if ("checkInTime" in record) resumenPorEmpleado[empId].asistencias++;
      if ("reason" in record) resumenPorEmpleado[empId].ausencias++;
      if ("name" in record) resumenPorEmpleado[empId].excepciones++;
    }

    customLog("Resumen por empleado:");
    for (const empId in resumenPorEmpleado) {
      const e = employees.find(emp => emp.id === empId);
      const nombre = e ? e.fullname() : empId;
      const r = resumenPorEmpleado[empId];
      customLog(`- ${nombre}: ${r.asistencias} asistencias, ${r.ausencias} ausencias, ${r.excepciones} excepciones`);
    }


    return {
      weekStart: weekStart.format("YYYY-MM-DD"),
      weekEnd: weekEnd.format("YYYY-MM-DD"),
      newAttendances: newAttendanceCount,
      automaticAttendance: automaticAttendanceCount,
      newAbsences: newAbsenceCount,
      overtimeRequests: overtimeRequests.length,
      detail,
    };
  }

  // generateAutomaticDailyAttendances: Genera asistencias automáticas para empleados AUTOMÁTICOS.
  public async generateAutomaticDailyAttendances(body: any, session: ClientSession): Promise<any> {
    const day = body.date ? moment(body.date).format("YYYY-MM-DD") : moment().format("YYYY-MM-DD");
    const dayOfWeek = moment(day).format("dddd").toLowerCase();
    const employees = await EmployeeModel.find({
      active: true,
      status: EEmployeStatus.ACTIVE,
      attendanceScheme: EEmployeeAttendanceScheme.AUTOMATIC,
    });
    let generated = 0;
    const bulkOps = [];
    for (const employee of employees) {
      const existing = await AttendanceModel.findOne({
        active: true,
        employeeId: employee.id,
        checkInTime: { $regex: `^${day}` },
      });
      if (existing) continue;
      const scheduleForDay = employee.schedule ? employee.schedule[dayOfWeek as keyof IEmployeSchedule] : null;
      if (!scheduleForDay || !scheduleForDay.start || !scheduleForDay.end) continue;
      const checkInTime = moment(`${day}T${scheduleForDay.start}:00`);
      const checkOutTime = moment(`${day}T${scheduleForDay.end}:00`);
      const id = "AT" + String(await consumeSequence("attendances", session)).padStart(8, "0");
      bulkOps.push({
        insertOne: {
          document: {
            id,
            employeeId: employee.id,
            employeeName: employee.fullname(),
            checkInTime: checkInTime.format("YYYY-MM-DD HH:mm:ss"),
            checkOutTime: checkOutTime.format("YYYY-MM-DD HH:mm:ss"),
            date: day,
            isLate: false,
          },
        },
      });
      generated++;
      customLog(`Asistencia automática preparada para ${employee.fullname()} (${id}) en ${day}`);
    }
    if (bulkOps.length > 0) {
      customLog(`Bulk automatic attendance operations: ${bulkOps.length} registros.`);
      await AttendanceModel.bulkWrite(bulkOps, { session });
      customLog("Bulk automatic attendance insert commitado.");
    }
    return { success: true, generated };
  }
}

const attendanceService: AttendanceService = new AttendanceService();
export default attendanceService;
