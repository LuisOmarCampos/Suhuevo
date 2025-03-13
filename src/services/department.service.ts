
import { IDepartment } from '@app/dtos/deparment.dto'
import { AppErrorResponse } from '@app/models/app.response'
import { DepartmentModel } from '@app/repositories/mongoose/models/department.model'
import { JobModel } from '@app/repositories/mongoose/models/job.model'
import { customLog } from '@app/utils/util.util'
import { type ClientSession } from 'mongoose'
import { v4 as uuidv4 } from 'uuid'


class DepartmentService {
  async get (query: any): Promise<any> {
    if (!query.ids) {
      customLog('[DepartmentService.get] No se enviaron IDs, devolviendo todos los departamentos.');
      return await DepartmentModel.find({ active: true });
    }
    
    const ids = Array.isArray(query.ids) ? query.ids : [query.ids]
    const records = await DepartmentModel.find({ active: true, id: { $in: ids } })

    return records.reduce((acc: Record<string, IDepartment>, record) => {
          acc[record.id] = record;
          return acc;
        }, {});
  }

  async search (query: any): Promise<any> {
    const { limit = 100, size, sortField, ...queryFields } = query

    const allowedFields: (keyof IDepartment)[] = ['id', 'name']

    const filter: any = { active: true }
    const selection: any = size === 'small' ? {} : { active: 0, _id: 0, __v: 0 }

    for (const field in queryFields) {
      if (!(allowedFields as any[]).includes(field.replace(/[~<>]/, ''))) {
        throw new AppErrorResponse({ statusCode: 403, name: `Campo no permitido: ${field}` })
      }

      const value = queryFields[field]
      const cleanField = field.replace(/[~<>]/, '')

      if (Array.isArray(value)) {
        filter[cleanField] = { $in: value }
      } else if (field.startsWith('~')) {
        filter[cleanField] = new RegExp('' + String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i')
      } else if (field.startsWith('<')) {
        filter[cleanField] = { ...filter[cleanField], $lt: value }
      } else if (field.startsWith('>')) {
        filter[cleanField] = { ...filter[cleanField], $gt: value }
      } else {
        filter[cleanField] = value
      }
    }

    const records = await DepartmentModel.find(filter).select(selection).limit(limit).sort({ createdAt: 'desc' })
    if (records.length === 0) return []

    // Delete later
    const recordsCopy = JSON.parse(JSON.stringify(records))
    for (const record of recordsCopy) {
      const jobs = await JobModel.find({ active: true, departmentId: record.id }).select({ _id: 0, id: 1, name: 1 })
      record.jobs = jobs
    }
    return recordsCopy
    //

    return records
  }

  async create (body: any, session: ClientSession): Promise<any> {
    const id = uuidv4()

    const record = new DepartmentModel({ ...body, id })
    customLog(`Creando departamento ${String(record.id)} (${String(record.name)})`)
    await record.save({ session })

    return { id: record.id }
  }

  async update (body: any, session: ClientSession): Promise<any> {
    const record = await DepartmentModel.findOne({ id: body.id })
    if (record == null) throw new AppErrorResponse({ statusCode: 404, name: 'No se encontró el departamento' })

    const allowedFields: (keyof IDepartment)[] = [
      'name',
      'managerId'
    ]

    for (const field of allowedFields) {
      if (body[field] !== undefined) {
        (record as any)[field] = body[field]
      }
    }

    await record.save({ validateBeforeSave: true, validateModifiedOnly: true, session })
    return { id: record.id }
  }
}

const departmentService: DepartmentService = new DepartmentService()
export default departmentService
