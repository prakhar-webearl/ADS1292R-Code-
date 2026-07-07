import TermsCondition from "../models/termsconditionModel.js";

const TEMPORARY_TERMS_CONDITION = {
  title: "Terms & Conditions",
  contentHtml: `<body>

<h1>Refund, Cancellation & Replacement Policy</h1>

<p>
    We at <strong>Sunfox Technologies Private Limited</strong> ("Sunfox" or "the Company") value your trust and strive to ensure a transparent and fair experience for every customer.
    This policy outlines the terms and conditions governing product returns, cancellations, refunds, and exchanges.
</p>

<div class="section">
    <h2>Return Policy</h2>

    <h3>Eligibility for Return</h3>
    <p>Customers may request a return within ten (10) calendar days from the date of receipt of the order, subject to the following conditions:</p>
    <ul>
        <li>A valid and reasonable justification is provided.</li>
        <li>The product is unused, in its original packaging, and free from damage or tampering.</li>
        <li>All components (manuals, warranty cards, accessories) are intact.</li>
    </ul>

    <h3>Return Procedure</h3>
    <ul>
        <li>Repack the device carefully in its original condition.</li>
        <li>Share a video recording of the packaging process for approval.</li>
        <li>Upon approval, a logistics partner will arrange doorstep pickup.</li>
    </ul>
</div>

<div class="section">
    <h2>Refund Policy</h2>

    <p>Refunds are processed after the returned product is received and passes quality inspection.</p>

    <h3>Refund Timeline</h3>
    <ul>
        <li>Bank Transfer (NEFT/IMPS): 3–4 business days</li>
        <li>UPI / Wallet: 1–2 business days</li>
    </ul>

    <h3>Mode of Refund</h3>
    <ul>
        <li>Refunds are processed via the original payment method.</li>
        <li>COD orders will be refunded via bank transfer only.</li>
        <li>Refunds will be issued in the original transaction currency.</li>
    </ul>

    <p><strong>Note:</strong> Sunfox is not responsible for exchange rate differences or bank charges.</p>

    <h3>Communication</h3>
    <p>All refund-related queries must be sent to: <strong>support@sunfox.in</strong></p>
</div>

<div class="section">
    <h2>Cancellation Policy</h2>

    <p>Orders cannot be canceled without a valid reason. Sunfox reserves the right to cancel orders under the following circumstances:</p>
    <ul>
        <li>Suspected fraudulent transactions</li>
        <li>Violation of Terms of Use</li>
        <li>Service unavailability</li>
        <li>Logistical issues beyond company control</li>
        <li>Business discretion</li>
    </ul>
</div>

<div class="section">
    <h2>Exchange / Replacement Policy</h2>

    <p>We offer a <strong>2-year replacement warranty</strong>.</p>

    <h3>Exchange Conditions</h3>
    <ul>
        <li>Applicable only for damaged, defective, or substandard products</li>
        <li>Subject to quality inspection by Sunfox team</li>
    </ul>

    <h3>Exchange Procedure</h3>
    <ul>
        <li>Submit request via email to support@sunfox.in</li>
        <li>Verification via call or communication</li>
        <li>Return the defective product</li>
        <li>Replacement shipped after approval with tracking details</li>
    </ul>
</div>

<div class="section">
    <h2>Shipping & Delivery Policy</h2>

    <ul>
        <li>Delivery within 2–3 business days after dispatch</li>
        <li>Handled by third-party logistics partners</li>
        <li>No additional delivery charges</li>
        <li>Returns cannot be processed at the time of delivery</li>
    </ul>
</div>

<div class="section">
    <h2>General Terms</h2>

    <ul>
        <li>Sunfox reserves the right to modify this policy at any time</li>
        <li>All decisions by the Company are final and binding</li>
        <li>This policy is governed by the laws of India</li>
    </ul>
</div>

</body>`,
};

const normalizeTermsCondition = (document) => {
  const termsCondition = document.toObject ? document.toObject() : document;
  if (!termsCondition.description && termsCondition.contentHtml) {
    termsCondition.description = termsCondition.contentHtml;
  }
  if (!termsCondition.contentHtml && termsCondition.description) {
    termsCondition.contentHtml = termsCondition.description;
  }
  return termsCondition;
};

const createTermsCondition = async (req, res) => {
  try {
    const { title, description, contentHtml } = req.body;
    const htmlContent = contentHtml || description;

    if (!title || !htmlContent) {
      return res.status(400).json({
        success: false,
        message: "title and contentHtml are required",
      });
    }

    const termscondition = new TermsCondition({
      title,
      description: htmlContent,
      contentHtml: htmlContent,
    });

    await termscondition.save();
    res.status(201).json({
      success: true,
      message: "Terms & Condition created successfully",
      termscondition: normalizeTermsCondition(termscondition),
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      message: "Error creating Terms & Condition",
      error: error.message,
    });
  }
};

const getAllTermsCondition = async (req, res) => {
    try {
      const termsConditions = await TermsCondition.find()
        .sort({ createdAt: -1 })
        .lean(); // Use lean() for better performance
  
      res.status(200).json({
        success: true,
        message: "Terms & Conditions fetched successfully",
        totalTerms: termsConditions.length,
        termsConditions: termsConditions.map((item) => normalizeTermsCondition(item)),
      });
    } catch (error) {
      res.status(500).json({
        success: false,
        message: "Error fetching Terms & Conditions",
        error: error.message,
      });
    }
}
  
const getTermsConditionById = async (req, res) => {
  try {
    const { id } = req.params;
    const gettermsconditionById = await TermsCondition.findById(id);
    if (!gettermsconditionById) {
      return res.status(404).json({
        success: false,
        message: "Terms & Condition not found",
      });
    }
    res.status(200).json({
      success: true,
      message: "Terms & Condition fetched successfully",
      gettermsconditionById: normalizeTermsCondition(gettermsconditionById),
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      message: "Error fetching Terms & Condition",
      error: error.message,
    });
  }
};

const getLatestTermsCondition = async (req, res) => {
  try {
    const latestTermsCondition = await TermsCondition.findOne()
      .sort({ createdAt: -1 })
      .lean();

    if (!latestTermsCondition) {
      return res.status(200).json({
        success: true,
        message: "Terms & Condition fetched successfully",
        termsCondition: {
          ...TEMPORARY_TERMS_CONDITION,
          description: TEMPORARY_TERMS_CONDITION.contentHtml,
          isTemporary: true,
        },
      });
    }

    return res.status(200).json({
      success: true,
      message: "Terms & Condition fetched successfully",
      termsCondition: normalizeTermsCondition(latestTermsCondition),
    });
  } catch (error) {
    return res.status(500).json({
      success: false,
      message: "Error fetching Terms & Condition",
      error: error.message,
    });
  }
};

const updateTermsCondition = async (req, res) => {
  try {
    const { id } = req.params;
    const { title, description, contentHtml } = req.body;
    const htmlContent = contentHtml || description;

    const updatePayload = {};

    if (title !== undefined) updatePayload.title = title;
    if (htmlContent !== undefined) {
      updatePayload.description = htmlContent;
      updatePayload.contentHtml = htmlContent;
    }

    if (Object.keys(updatePayload).length === 0) {
      return res.status(400).json({
        success: false,
        message: "No valid fields provided for update",
      });
    }

    const updatetermscondition = await TermsCondition.findByIdAndUpdate(
      id,
      updatePayload,
      {
        returnDocument: 'after',
        runValidators: true,
      }
    );

    if (!updatetermscondition) {
      return res.status(404).json({ success: false, message: "Terms & Condition not found" });
    }

    res.status(200).json({
      success: true,
      message: "Terms & Condition updated successfully",
      updatetermscondition: normalizeTermsCondition(updatetermscondition),
    });
  } catch (error) {
    console.error("Error updating Terms & Condition:", error);
    res.status(500).json({ success: false, message: "Server error", error: error.message });
  }
};

const deleteTermsCondition = async (req, res) => {
  try {
    const deletetermscondition = await TermsCondition.findByIdAndDelete(
      req.params.id
    );
    if (!deletetermscondition)
      return res.status(404).json({ success: false, message: "Terms & Condition not found" });
    res.json({ success: true, message: "Terms & Condition deleted successfully" });
  } catch (error) {
    res.status(500).json({ success: false, message: "Delete failed", error: error.message });
  }
};

export {
  createTermsCondition,
  getAllTermsCondition,
  getTermsConditionById,
  getLatestTermsCondition,
  updateTermsCondition,
  deleteTermsCondition,
};
