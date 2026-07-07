import PrivacyPolicy from "../models/privacypolicyModel.js";

const TEMPORARY_PRIVACY_POLICY = {
  title: "Privacy Policy",
  contentHtml: `"<body>

<h1>Terms of Use</h1>

<div class="section">
    <h2>Welcome to Sunfox</h2>
    <p>
        This legal agreement is an electronic record under the Information Technology Act, 2000 and applicable rules.
        It does not require physical or digital signatures.
    </p>
    <p>
        This document is published in accordance with applicable IT rules requiring Terms of Use and practices for access and usage.
    </p>
</div>

<div class="section">
    <h2>Company Information</h2>
    <p>
        This Website is operated by <strong>Sunfox Technologies Private Limited</strong>,
        having its registered office at:
    </p>
    <p>
        112, Dharampur Road, Nehru Colony,<br>
        Dehradun, Uttarakhand, India – 248001
    </p>
    <p>
        Website: <strong>sunfox.in</strong>
    </p>
</div>

<div class="section">
    <h2>General Terms</h2>
    <ul>
        <li>Use of this Website is governed by these Terms and Privacy Policy.</li>
        <li>Continued usage implies acceptance of updated terms.</li>
        <li>We may modify these terms at any time without prior notice.</li>
    </ul>
</div>

<div class="section">
    <h2>Platform Overview</h2>
    <p>
        Sunfox Technologies was established in 2016 as an R&D lab in Uttarakhand,
        focusing on Biomedical Instrumentation, IoT, and engineering innovations.
    </p>
</div>

<div class="section">
    <h2>Registration</h2>
    <p>Registration is optional. Users may provide:</p>
    <ul>
        <li>Name</li>
        <li>Phone Number</li>
        <li>Email ID</li>
        <li>Address</li>
        <li>Profession</li>
        <li>Preferred contact time</li>
    </ul>
</div>

<div class="section">
    <h2>Eligibility</h2>
    <ul>
        <li>You must be legally competent to enter contracts.</li>
        <li>Minors may use the Website with guardian consent.</li>
        <li>You must comply with all applicable laws.</li>
    </ul>
</div>

<div class="section">
    <h2>Payment Gateway</h2>
    <p>
        Payments are processed via third-party gateways (e.g., Razorpay).
        Users are subject to the gateway’s terms and policies.
    </p>
</div>

<div class="section">
    <h2>Content</h2>
    <ul>
        <li>All content is protected by copyright.</li>
        <li>You may not reuse content without permission.</li>
        <li>You are responsible for any content you submit.</li>
        <li>We may suspend accounts for misleading or offensive content.</li>
    </ul>
</div>

<div class="section">
    <h2>Indemnity</h2>
    <p>
        You agree to indemnify and hold harmless the Company against any losses,
        claims, or damages arising from your use of the Website or violation of these terms.
    </p>
</div>

<div class="section">
    <h2>Limitation of Liability</h2>
    <ul>
        <li>We are not liable for connectivity issues or technical failures.</li>
        <li>No liability for data loss, delays, or service interruptions.</li>
        <li>Use of Website is at your own risk.</li>
    </ul>
</div>

<div class="section">
    <h2>Termination</h2>
    <ul>
        <li>We may suspend or terminate access at any time.</li>
        <li>You may stop using the Website at any time.</li>
    </ul>
</div>

<div class="section">
    <h2>Communication</h2>
    <p>
        By using the Website, you consent to receive emails/SMS from us.
    </p>
    <p>
        For issues, contact: <strong>support@sunfox.in</strong>
    </p>
</div>

<div class="section">
    <h2>User Obligations</h2>
    <ul>
        <li>Provide accurate and updated information.</li>
        <li>Do not impersonate others or misuse the Website.</li>
        <li>Do not upload harmful, illegal, or offensive content.</li>
        <li>Do not attempt to hack or disrupt the Website.</li>
    </ul>
</div>

<div class="section">
    <h2>Intellectual Property</h2>
    <p>
        All trademarks, logos, and content belong to Sunfox or respective owners.
        Unauthorized use is prohibited.
    </p>
</div>

<div class="section">
    <h2>Disclaimer</h2>
    <ul>
        <li>Website is provided "as is" without warranties.</li>
        <li>No guarantee of uninterrupted or error-free service.</li>
    </ul>
</div>

<div class="section">
    <h2>Force Majeure</h2>
    <p>
        We are not liable for delays due to events beyond control such as natural disasters,
        war, internet failure, or technical issues.
    </p>
</div>

<div class="section">
    <h2>Dispute Resolution</h2>
    <p>
        Disputes will first be resolved via mediation through CORD.
        If unresolved, arbitration will be conducted in Uttarakhand, India.
    </p>
</div>

<div class="section">
    <h2>Miscellaneous</h2>
    <ul>
        <li>These Terms form the entire agreement.</li>
        <li>If any clause is invalid, others remain valid.</li>
        <li>Governed by laws of India.</li>
    </ul>
</div>

<div class="section">
    <h2>Contact Us</h2>
    <p>
        Email: support@sunfox.in<br><br>
        Address:<br>
        M/s Sunfox Technologies Private Limited<br>
        112, Dharampur Road, Nehru Colony<br>
        Dehradun, Uttarakhand, India
    </p>
</div>

</body>"`,
};

const normalizePrivacyPolicy = (document) => {
  const privacyPolicy = document.toObject ? document.toObject() : document;
  if (!privacyPolicy.description && privacyPolicy.contentHtml) {
    privacyPolicy.description = privacyPolicy.contentHtml;
  }
  if (!privacyPolicy.contentHtml && privacyPolicy.description) {
    privacyPolicy.contentHtml = privacyPolicy.description;
  }
  return privacyPolicy;
};

const createPrivacyPolicy = async (req, res) => {
  try {
    const { title, description, contentHtml } = req.body;
    const htmlContent = contentHtml || description;

    if (!title || !htmlContent) {
      return res.status(400).json({
        success: false,
        message: "title and contentHtml are required",
      });
    }

    const privacypolicy = new PrivacyPolicy({
      title,
      description: htmlContent,
      contentHtml: htmlContent,
    });

    await privacypolicy.save();
    res.status(201).json({
      success: true,
      message: "PrivacyPolicy created successfully",
      privacypolicy: normalizePrivacyPolicy(privacypolicy),
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      message: "Error creating PrivacyPolicy",
      error: error.message,
    });
  }
};

const getAllPrivacyPolicy = async (req, res) => {
    try {
      const privacyPolicies = await PrivacyPolicy.find()
        .sort({ createdAt: -1 })
        .lean(); // Use lean() for better performance
  
      res.status(200).json({
        success: true,
        message: "Privacy Policies fetched successfully",
        totalPrivacyPolicies: privacyPolicies.length,
        privacyPolicies: privacyPolicies.map((item) => normalizePrivacyPolicy(item)),
      });
    } catch (error) {
      res.status(500).json({
        success: false,
        message: "Error fetching Privacy Policies",
        error: error.message,
      });
    }
}
  
const getPrivacyPolicyById = async (req, res) => {
  try {
    const { id } = req.params;
    const getprivacypolicyById = await PrivacyPolicy.findById(id);
    if (!getprivacypolicyById) {
      return res.status(404).json({
        success: false,
        message: "PrivacyPolicy not found",
      });
    }
    res.status(200).json({
      success: true,
      message: "PrivacyPolicy fetched successfully",
      getprivacypolicyById: normalizePrivacyPolicy(getprivacypolicyById),
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      message: "Error fetching PrivacyPolicy",
      error: error.message,
    });
  }
};

const getLatestPrivacyPolicy = async (req, res) => {
  try {
    const latestPrivacyPolicy = await PrivacyPolicy.findOne()
      .sort({ createdAt: -1 })
      .lean();

    if (!latestPrivacyPolicy) {
      return res.status(200).json({
        success: true,
        message: "PrivacyPolicy fetched successfully",
        privacyPolicy: {
          ...TEMPORARY_PRIVACY_POLICY,
          description: TEMPORARY_PRIVACY_POLICY.contentHtml,
          isTemporary: true,
        },
      });
    }

    return res.status(200).json({
      success: true,
      message: "PrivacyPolicy fetched successfully",
      privacyPolicy: normalizePrivacyPolicy(latestPrivacyPolicy),
    });
  } catch (error) {
    return res.status(500).json({
      success: false,
      message: "Error fetching PrivacyPolicy",
      error: error.message,
    });
  }
};

const updatePrivacyPolicy = async (req, res) => {
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

    const updateprivacypolicy = await PrivacyPolicy.findByIdAndUpdate(
      id,
      updatePayload,
      {
        returnDocument: 'after',
        runValidators: true,
      }
    );

    if (!updateprivacypolicy) {
      return res.status(404).json({ success: false, message: "PrivacyPolicy not found" });
    }

    res.status(200).json({
      success: true,
      message: "PrivacyPolicy updated successfully",
      updateprivacypolicy: normalizePrivacyPolicy(updateprivacypolicy),
    });
  } catch (error) {
    console.error("Error updating PrivacyPolicy:", error);
    res.status(500).json({ success: false, message: "Server error", error: error.message });
  }
};

const deletePrivacyPolicy = async (req, res) => {
  try {
    const deleteprivacypolicy = await PrivacyPolicy.findByIdAndDelete(
      req.params.id
    );
    if (!deleteprivacypolicy)
      return res.status(404).json({ success: false, message: "PrivacyPolicy not found" });
    res.json({ success: true, message: "PrivacyPolicy deleted successfully" });
  } catch (error) {
    res.status(500).json({ success: false, message: "Delete failed", error: error.message });
  }
};

export {
  createPrivacyPolicy,
  getAllPrivacyPolicy,
  getPrivacyPolicyById,
  getLatestPrivacyPolicy,
  updatePrivacyPolicy,
  deletePrivacyPolicy,
};
