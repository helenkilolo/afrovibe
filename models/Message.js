const mongoose = require('mongoose');
const { Schema } = mongoose;

const MessageSchema = new Schema({
  sender:    { type: Schema.Types.ObjectId, ref: 'User', required: true },
  recipient: { type: Schema.Types.ObjectId, ref: 'User', required: true },
  content:   { type: String, trim: true, required: true },
  read:      { type: Boolean, default: false },
  createdAt: { type: Date, default: Date.now },
  // store who has soft-deleted this message
  deletedFor: [{ type: Schema.Types.ObjectId, ref: 'User', index: true, default: [] }],
});

// ✅ Fast thread paging & “before” loads (keeps sort usable)
MessageSchema.index({ sender: 1, recipient: 1, createdAt: -1 });

// ✅ Unread badge / recent unread scans (your current one is fine)
MessageSchema.index({ recipient: 1, read: 1, createdAt: -1 });

// ➕ Helps per-thread unread counts (group by sender quickly)
MessageSchema.index({ recipient: 1, read: 1, sender: 1 });

// ➕ Helps filters that exclude soft-deleted msgs for a user
// (note: $nin on arrays can’t fully use an index, but this still helps)
MessageSchema.index({ recipient: 1, deletedFor: 1, createdAt: -1 });

// Optional (if you often fetch “my sent to X” quickly)
MessageSchema.index({ sender: 1, recipient: 1, read: 1 });

module.exports = mongoose.model('Message', MessageSchema);

