// models/Notification.js
const mongoose = require('mongoose');
const { Schema } = mongoose;

const NotificationSchema = new Schema({
  recipient: { type: Schema.Types.ObjectId, ref: 'User', required: true, index: true },
  sender:    { type: Schema.Types.ObjectId, ref: 'User', default: null }, // was required: true
  type:      { type: String, enum: ['like','match','favorite','wave','verification','subscription','system', 'superlike'], required: true },
  message:   { type: String, required: true, trim: true },
  data:      { type: Schema.Types.Mixed, default: {} },                    // e.g. { link, userId }
  read:      { type: Boolean, default: false, index: true },

  // soft-delete per recipient (mirrors Message.deletedFor)
  deletedFor: [{ type: Schema.Types.ObjectId, ref: 'User', index: true }],
}, { timestamps: { createdAt: true, updatedAt: false } });

NotificationSchema.index({ recipient: 1, read: 1, createdAt: -1 });

module.exports = mongoose.models.Notification || mongoose.model('Notification', NotificationSchema);
