// models/Report.js - New Mongoose model for storing user reports

const mongoose = require('mongoose');
const Schema = mongoose.Schema;

const reportSchema = new Schema({
    reporter: {
        type: Schema.Types.ObjectId,
        ref: 'User',
        required: true
    },
    reportedUser: {
        type: Schema.Types.ObjectId,
        ref: 'User',
        required: true
    },
    reason: {
        type: String,
        required: true,
        enum: ['Spam', 'Inappropriate Content', 'Harassment', 'Fake Profile', 'Other']
    },
    details: {
        type: String,
        required: false,
        maxlength: 500
    },
    status: {
        type: String,
        enum: ['Pending', 'Reviewed', 'Dismissed'],
        default: 'Pending'
    },
}, {
    timestamps: true
});

const Report = mongoose.model('Report', reportSchema);

module.exports = Report;
