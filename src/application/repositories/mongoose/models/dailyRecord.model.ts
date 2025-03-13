import { Schema, model, Document, Types, SchemaTypes } from "mongoose";
import { AppMainMongooseRepo } from "..";

/**
 * @swagger
 * components:
 *   schemas:
 *     DailyRecord:
 *       type: object
 *       required:
 *         - shedId
 *         - date
 *         - liveChickens
 *         - foodConsumedKg
 *         - producedBoxes
 *         - producedEggs
 *         - mortality
 *         - avgEggWeight
 *         - avgHensWeight
 *         - waterConsumedL
 *         - createdBy
 *         - updatedBy
 *         - createdAt
 *         - updatedAt
 *       properties:
 *         shedId:
 *           type: string
 *           example: "65fbf3214abc9876def91234"
 *           description: ID de la caseta a la que pertenece el registro
 *         date:
 *           type: string
 *           format: date-time
 *           example: "2024-03-01T12:00:00Z"
 *           description: Fecha y hora en que se registró la producción
 *         liveChickens:
 *           type: number
 *           example: 19500
 *           description: Cantidad de gallinas vivas en la caseta
 *         foodConsumedKg:
 *           type: number
 *           example: 150.5
 *           description: Cantidad de alimento consumido en kilogramos
 *         producedBoxes:
 *           type: number
 *           example: 20
 *           description: Cantidad de cajas de huevos producidas
 *         producedEggs:
 *           type: number
 *           example: 6000
 *           description: Cantidad total de huevos producidos
 *         mortality:
 *           type: number
 *           example: 10
 *           description: Cantidad de gallinas muertas en el día
 *         avgEggWeight:
 *           type: number
 *           example: 65
 *           description: Peso promedio del huevo en gramos
 *         avgHensWeight:
 *           type: number
 *           example: 1.8
 *           description: Peso promedio de las gallinas en kg
 *         waterConsumedL:
 *           type: number
 *           example: 200
 *           description: Litros de agua consumidos en la caseta
 *         createdBy:
 *           type: string
 *           example: "65fbf3214abc9876def91237"
 *           description: ID del usuario que creó el registro
 *         updatedBy:
 *           type: string
 *           example: "65fbf3214abc9876def91238"
 *           description: ID del usuario que actualizó el registro
 *         createdAt:
 *           type: string
 *           format: date-time
 *           example: "2024-03-01T12:00:00Z"
 *           description: Fecha y hora de creación del registro
 *         updatedAt:
 *           type: string
 *           format: date-time
 *           example: "2024-03-01T12:30:00Z"
 *           description: Fecha y hora de la última actualización
 */

export interface IDailyRecord extends Document {
  shedId: Types.ObjectId;
  generationId: String;
  date: Date;
  hensAlive: number;
  foodConsumedKg: number;
  producedBoxes: number;
  producedEggs: number;
  mortality: number;
  uniformity: number;
  totalNetWeight: number;
  avgEggWeight: number;
  avgHensWeight: number;
  createdBy: Types.ObjectId;
  updatedBy: Types.ObjectId;
  createdAt: Date;
  updatedAt: Date;
}

/**
 * @swagger
 * components:
 *   schemas:
 *     DailyRecordIndex:
 *       type: object
 *       description: Índices en la base de datos para optimizar las consultas de registros diarios de producción.
 *       properties:
 *         shedId:
 *           type: string
 *           example: "65fbf3214abc9876def91234"
 *           description: ID de la caseta utilizada como índice para mejorar consultas por caseta.
 *         date:
 *           type: string
 *           format: date-time
 *           example: "2024-03-01T12:00:00Z"
 *           description: Índice basado en la fecha para optimizar búsquedas por día específico.
 *       responses:
 *         200:
 *           description: Índices generados y utilizados correctamente en la base de datos.
 *         500:
 *           description: Error en la base de datos al intentar generar índices.
 */

const DailyRecordSchema = new Schema<IDailyRecord>(
  {
    shedId: { type: SchemaTypes.ObjectId, ref: "Shed", required: true, index: true },
    generationId: { type: String, required: true },
    date: { type: Date, required: true, default: Date.now, index: true },
    hensAlive: { type: Number, required: true },
    foodConsumedKg: { type: Number, required: true },
    producedBoxes: { type: Number },
    producedEggs: { type: Number },
    mortality: { type: Number, required: true },
    uniformity: { type: Number },
    totalNetWeight: { type: Number, required: true, default: 0 },
    avgEggWeight: { type: Number },
    avgHensWeight: { type: Number, required: true },
    createdBy: { type: SchemaTypes.ObjectId, ref: "user", required: true, immutable: true },
    updatedBy: { type: SchemaTypes.ObjectId, ref: "user", required: true, immutable: true },
  },
  { timestamps: true }
);

export const DailyRecordModel = AppMainMongooseRepo.model<IDailyRecord>("DailyRecord", DailyRecordSchema);
